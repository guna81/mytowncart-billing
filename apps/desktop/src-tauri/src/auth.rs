// SPDX-License-Identifier: Apache-2.0
//! PIN hashing, login sessions, brute-force throttling and the command
//! permission policy. Enforced in Rust so it holds for the LAN browser as well
//! as the desktop window — the UI only mirrors it.
//!
//! Roles: `cashier` < `owner`. While no active user has a PIN the shop is in
//! "setup mode" and every command is allowed (there is nobody to log in as).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use sha2::{Digest, Sha256};

const HASH_PREFIX: &str = "h1";
const HASH_ROUNDS: u32 = 60_000;
const SESSION_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const MAX_FAILURES: u32 = 8;
const LOCKOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Cashier,
    Owner,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "cashier" => Some(Role::Cashier),
            "owner" => Some(Role::Owner),
            _ => None,
        }
    }
}

/// Minimum role for a command. `None` = needs no login at all.
pub fn required_role(cmd: &str) -> Option<Role> {
    match cmd {
        // Needed to reach the lock screen.
        "verify_pin" | "list_users" | "logout" => None,
        // Money-moving, stock-changing and configuration commands.
        "void_bill" | "adjust_stock" | "create_credit_note" | "apply_stock_audit" | "upsert_user"
        | "create_purchase" | "upsert_item" | "import_items" | "delete_customer" | "upsert_supplier"
        | "delete_supplier" | "save_shop_profile" | "list_audit_logs" | "get_bills_report_data"
        | "marketplace_connect" | "marketplace_disconnect" => {
            Some(Role::Owner)
        }
        // Everything else (selling, looking things up, receiving customer payments).
        _ => Some(Role::Cashier),
    }
}

// ---------------------------------------------------------------------------
// PIN hashing
// ---------------------------------------------------------------------------

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn derive(salt: &[u8], pin: &str) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(salt);
    h.update(pin.as_bytes());
    let mut cur = h.finalize().to_vec();
    for _ in 0..HASH_ROUNDS {
        let mut h = Sha256::new();
        h.update(&cur);
        h.update(salt);
        cur = h.finalize().to_vec();
    }
    cur
}

pub fn hash_pin(pin: &str) -> Result<String, String> {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|e| format!("cannot generate salt: {e}"))?;
    Ok(format!("{HASH_PREFIX}${}${}", to_hex(&salt), to_hex(&derive(&salt, pin))))
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

pub fn verify_pin_hash(pin: &str, stored: &str) -> bool {
    let mut parts = stored.split('$');
    if parts.next() != Some(HASH_PREFIX) {
        return false;
    }
    let (Some(salt_hex), Some(hash_hex)) = (parts.next(), parts.next()) else {
        return false;
    };
    let Some(salt) = from_hex(salt_hex) else { return false };
    let got = to_hex(&derive(&salt, pin));
    got.len() == hash_hex.len()
        && got.bytes().zip(hash_hex.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0
}

pub fn validate_pin(pin: &str) -> Result<(), String> {
    if (4..=6).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err("PIN must be 4 to 6 digits".to_string())
    }
}

/// One-off: hash PINs that were stored in clear by earlier versions and blank the old column.
pub fn upgrade_legacy_pins(conn: &Connection) -> Result<usize, String> {
    let mut stmt = conn
        .prepare("SELECT id, pin FROM users WHERE pin <> ''")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (id, pin) in &rows {
        conn.execute(
            "INSERT INTO user_pins (user_id, hash) VALUES (?1, ?2)
             ON CONFLICT (user_id) DO UPDATE SET hash = excluded.hash",
            rusqlite::params![id, hash_pin(pin)?],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("UPDATE users SET pin = '' WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    }
    Ok(rows.len())
}

/// True once at least one active user has a PIN (so logging in is required).
pub fn login_required(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM users u JOIN user_pins p ON p.user_id = u.id WHERE u.is_active = 1",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(true) // fail closed
}

// ---------------------------------------------------------------------------
// Sessions + throttle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Session {
    pub user_id: i64,
    pub role: Role,
    expires: Instant,
}

#[derive(Default)]
pub struct Auth {
    sessions: Mutex<HashMap<String, Session>>,
    failures: Mutex<(u32, Option<Instant>)>,
}

impl Auth {
    /// Err(seconds_left) while locked out after too many wrong PINs.
    pub fn check_throttle(&self) -> Result<(), u64> {
        let mut f = self.failures.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(until) = f.1 {
            let now = Instant::now();
            if now < until {
                return Err((until - now).as_secs() + 1);
            }
            *f = (0, None);
        }
        Ok(())
    }

    pub fn record_failure(&self) {
        let mut f = self.failures.lock().unwrap_or_else(|e| e.into_inner());
        f.0 += 1;
        if f.0 >= MAX_FAILURES {
            f.1 = Some(Instant::now() + LOCKOUT);
        }
    }

    pub fn record_success(&self) {
        *self.failures.lock().unwrap_or_else(|e| e.into_inner()) = (0, None);
    }

    pub fn create_session(&self, user_id: i64, role: Role) -> Result<String, String> {
        let mut buf = [0u8; 24];
        getrandom::fill(&mut buf).map_err(|e| format!("cannot create session: {e}"))?;
        let token = to_hex(&buf);
        let mut s = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        s.retain(|_, v| v.expires > now);
        s.insert(token.clone(), Session { user_id, role, expires: now + SESSION_TTL });
        Ok(token)
    }

    pub fn end_session(&self, token: &str) {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(token);
    }

    pub fn clear_sessions(&self) {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    pub fn session(&self, token: &str) -> Option<Session> {
        let mut s = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        match s.get(token) {
            Some(sess) if sess.expires > Instant::now() => Some(sess.clone()),
            Some(_) => {
                s.remove(token);
                None
            }
            None => None,
        }
    }

    /// Authorise `cmd` for the holder of `token`. Open in setup mode (no PINs yet).
    /// Returns the acting user's id (None when no login is involved) for the audit log.
    pub fn authorize_setting(&self, conn: &Connection, key: &str, token: Option<&str>) -> Result<Option<i64>, String> {
        if !is_owner_setting(key) {
            // Background jobs (auto-backup, sync status) write these while the terminal is locked.
            return Ok(token.and_then(|t| self.session(t)).map(|s| s.user_id));
        }
        self.authorize(conn, "save_shop_profile", token)
    }

    pub fn authorize(&self, conn: &Connection, cmd: &str, token: Option<&str>) -> Result<Option<i64>, String> {
        let sess = token.and_then(|t| self.session(t));
        let Some(min) = required_role(cmd) else { return Ok(sess.map(|s| s.user_id)) };
        if !login_required(conn) {
            return Ok(sess.map(|s| s.user_id));
        }
        let sess = sess.ok_or_else(|| "login required".to_string())?;
        if sess.role >= min {
            Ok(Some(sess.user_id))
        } else {
            Err(format!("This action ({cmd}) needs the owner. Lock the terminal and log in with the owner PIN."))
        }
    }
}

/// Settings that change how the shop's terminal is exposed or branded. Other
/// keys (backup status, sync status, caches) are written by routine work that
/// cashiers also do, so they stay open to every signed-in user.
pub fn is_owner_setting(key: &str) -> bool {
    key.starts_with("lan.") || key == "shop.logo" || key == "pilot.diagnostics"
}

/// Record a sensitive action (who did what) in the audit log. Best effort: a
/// failure to log never undoes the action that already succeeded.
pub fn audit(conn: &Connection, user_id: Option<i64>, action: &str, details: String) {
    let _ = conn.execute(
        "INSERT INTO audit_logs (user_id, action, details, created_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))",
        rusqlite::params![user_id, action, details],
    );
}

/// PIN login. Returns the user (as JSON, plus `sessionToken` for a plain login).
/// A role-restricted check ("is this the owner's PIN?") never creates a session.
pub fn login(
    auth: &Auth,
    conn: &Connection,
    pin: &str,
    required_role: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    if let Err(secs) = auth.check_throttle() {
        return Err(format!("Too many wrong PINs. Try again in {secs} seconds."));
    }
    match crate::repo::verify_pin(conn, pin, required_role)? {
        None => {
            auth.record_failure();
            Ok(None)
        }
        Some(user) => {
            auth.record_success();
            let mut v = serde_json::to_value(&user).map_err(|e| e.to_string())?;
            if required_role.is_none() {
                let role = Role::parse(&user.role).unwrap_or(Role::Cashier);
                let token = auth.create_session(user.id, role)?;
                v["sessionToken"] = serde_json::Value::String(token);
            }
            Ok(Some(v))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_verify_and_are_salted() {
        let a = hash_pin("1234").unwrap();
        let b = hash_pin("1234").unwrap();
        assert_ne!(a, b);
        assert!(verify_pin_hash("1234", &a));
        assert!(!verify_pin_hash("1235", &a));
        assert!(!verify_pin_hash("1234", "1234"));
        assert!(!a.contains("1234"));
    }

    #[test]
    fn pin_format_rules() {
        assert!(validate_pin("1234").is_ok());
        assert!(validate_pin("123456").is_ok());
        assert!(validate_pin("123").is_err());
        assert!(validate_pin("12a4").is_err());
        assert!(validate_pin("1234567").is_err());
    }

    #[test]
    fn throttle_locks_after_repeated_failures_and_resets_on_success() {
        let auth = Auth::default();
        for _ in 0..MAX_FAILURES - 1 {
            auth.record_failure();
        }
        assert!(auth.check_throttle().is_ok());
        auth.record_failure();
        assert!(auth.check_throttle().is_err());
        *auth.failures.lock().unwrap() = (0, None);
        assert!(auth.check_throttle().is_ok());
    }

    #[test]
    fn policy_marks_owner_only_commands() {
        assert_eq!(required_role("void_bill"), Some(Role::Owner));
        assert_eq!(required_role("create_bill"), Some(Role::Cashier));
        assert_eq!(required_role("verify_pin"), None);
        assert!(Role::Owner > Role::Cashier);
    }
}
