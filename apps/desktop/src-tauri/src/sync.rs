// SPDX-License-Identifier: Apache-2.0
//! B5 — durable state for two-way sync: the app-settings JSON documents the UI
//! owns (backup schedule, pilot diagnostics, reconciliation reminders), the
//! `sync_state` cursors, and the stock outbox that must survive restarts.
//!
//! The web layer decides *what* to send; this module only guarantees that a
//! movement is enqueued exactly once (UNIQUE idempotency_key) and that a
//! remote feed page is applied together with its cursor in one transaction.

use rusqlite::{Connection, TransactionBehavior};

use crate::repo::RepoResult;

pub const MAX_SETTINGS_JSON: usize = 32 * 1024;

/// Small JSON documents keyed by name (e.g. `backup`, `pilot`).
pub fn get_setting(conn: &Connection, key: &str) -> RepoResult<Option<String>> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        rusqlite::params![key],
        |r| r.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.to_string()),
    })
}

/// Overwrite one document. `null` deletes it (so "reset to defaults" is the
/// absence of a row rather than a magic value).
pub fn set_setting(conn: &Connection, key: &str, value: Option<String>) -> RepoResult<()> {
    if key.trim().is_empty() {
        return Err("setting key is required".to_string());
    }
    match value {
        None => {
            conn.execute("DELETE FROM app_settings WHERE key = ?1", rusqlite::params![key])
                .map_err(|e| e.to_string())?;
        }
        Some(json) => {
            if json.len() > MAX_SETTINGS_JSON {
                return Err("setting document is too large".to_string());
            }
            serde_json::from_str::<serde_json::Value>(&json)
                .map_err(|e| format!("setting must be JSON: {e}"))?;
            conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                rusqlite::params![key, json],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[allow(dead_code)]
pub fn get_cursor(conn: &Connection, key: &str) -> RepoResult<Option<String>> {
    conn.query_row("SELECT value FROM sync_state WHERE key = ?1", rusqlite::params![key], |r| r.get(0))
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
}

pub fn set_cursor(conn: &Connection, key: &str, value: &str) -> RepoResult<()> {
    conn.execute(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Stock outbox.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct OutboxRow {
    pub id: i64,
    pub kind: String,
    pub payload_json: String,
    pub idempotency_key: String,
    pub attempts: i64,
    pub next_attempt_at: Option<String>,
    pub status: String,
}

/// Enqueue movements. Idempotency keys are unique, so re-enqueuing a key that
/// already exists (successfully pushed or still pending) is a silent no-op —
/// callers can enqueue defensively after every movement write.
///
/// Returns the idempotency keys that were actually inserted.
pub fn enqueue_stock_outbox(
    conn: &Connection,
    moves: &[(String, String)],
) -> RepoResult<Vec<String>> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut inserted = Vec::new();
    for (payload_json, key) in moves {
        if key.trim().is_empty() || payload_json.trim().is_empty() {
            return Err("an outbox row needs a payload and an idempotency key".to_string());
        }
        serde_json::from_str::<serde_json::Value>(payload_json)
            .map_err(|e| format!("outbox payload must be JSON: {e}"))?;
        let n = tx
            .execute(
                "INSERT INTO outbox (kind, payload_json, idempotency_key, attempts, next_attempt_at, status)
                 VALUES ('stock', ?1, ?2, 0, NULL, 'pending')
                 ON CONFLICT (idempotency_key) DO NOTHING",
                rusqlite::params![payload_json, key],
            )
            .map_err(|e| e.to_string())?;
        if n == 1 {
            inserted.push(key.clone());
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

#[allow(dead_code)]
pub fn list_outbox(conn: &Connection, status: Option<&str>) -> RepoResult<Vec<OutboxRow>> {
    let mut sql = String::from(
        "SELECT id, kind, payload_json, idempotency_key, attempts, next_attempt_at, status
         FROM outbox",
    );
    if status.is_some() {
        sql.push_str(" WHERE status = ?1");
    }
    sql.push_str(" ORDER BY id");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let map = |r: &rusqlite::Row| {
        Ok(OutboxRow {
            id: r.get(0)?,
            kind: r.get(1)?,
            payload_json: r.get(2)?,
            idempotency_key: r.get(3)?,
            attempts: r.get(4)?,
            next_attempt_at: r.get(5)?,
            status: r.get(6)?,
        })
    };
    let rows = match status {
        Some(s) => stmt.query_map(rusqlite::params![s], map),
        None => stmt.query_map([], map),
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub const OUTBOX_OUTCOMES: &[&str] = &["done", "retry"];

/// Record the result of one push attempt. `done` is terminal (the server
/// applied it or reported it as a duplicate); `retry` bumps attempts and
/// schedules the next try.
pub fn record_outbox_result(
    conn: &Connection,
    attempts: &[(String, String, Option<String>)],
) -> RepoResult<()> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (key, outcome, next_attempt_at) in attempts {
        if !OUTBOX_OUTCOMES.contains(&outcome.as_str()) {
            return Err(format!("bad outbox outcome \"{outcome}\""));
        }
        let n = if outcome == "done" {
            tx.execute(
                "UPDATE outbox SET status = 'done', attempts = attempts + 1, next_attempt_at = NULL
                 WHERE idempotency_key = ?1",
                rusqlite::params![key],
            )
            .map_err(|e| e.to_string())?
        } else {
            if next_attempt_at.is_none() {
                return Err("a retry needs a next_attempt_at".to_string());
            }
            tx.execute(
                "UPDATE outbox SET status = 'pending', attempts = attempts + 1, next_attempt_at = ?2
                 WHERE idempotency_key = ?1",
                rusqlite::params![key, next_attempt_at],
            )
            .map_err(|e| e.to_string())?
        };
        if n == 0 {
            return Err(format!("no outbox row for key {key}"));
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Obsolete moves (unknown item, item unpublished, or too many attempts) are
/// retired so one poison row can never block the queue forever.
pub fn drop_outbox(conn: &Connection, keys: &[String]) -> RepoResult<()> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for key in keys {
        tx.execute("DELETE FROM outbox WHERE idempotency_key = ?1", rusqlite::params![key])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Remote stock feed (pull): cursor + movements in ONE transaction.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStockMovePayload {
    pub external_id: String,
    pub delta_units: i64,
    pub reason: String,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppliedRemoteMove {
    pub external_id: String,
    pub item_id: Option<i64>,
    pub delta_milli: i64,
    pub reason: String,
}

const PULL_REASONS: &[&str] = &["online_order", "order_cancel", "adjustment"];

/// Apply one page of the marketplace stock feed as local `sync` movements
/// (one per unit traded) and advance the cursor in the SAME transaction, so a
/// crash can never re-apply a page or skip one. An external id we cannot
/// resolve is reported back, never invented; the server's cursor already
/// guarantees each movement id is seen once.
pub fn apply_stock_pull(
    conn: &mut Connection,
    cursor: &str,
    moves: &[RemoteStockMovePayload],
) -> RepoResult<Vec<AppliedRemoteMove>> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut applied = Vec::new();
    for mv in moves {
        if !PULL_REASONS.contains(&mv.reason.as_str()) {
            return Err(format!("bad remote stock reason \"{}\"", mv.reason));
        }
        if mv.delta_units == 0 {
            continue;
        }
        let item_id: Option<i64> = tx
            .query_row(
                "SELECT id FROM items WHERE remote_product_id = ?1 OR ('itm_' || id) = ?1",
                rusqlite::params![mv.external_id],
                |r| r.get(0),
            )
            .ok();
        if let Some(id) = item_id {
            let delta_milli = mv
                .delta_units
                .checked_mul(1000)
                .ok_or("remote delta out of range")?;
            tx.execute(
                "INSERT INTO stock_movements (item_id, delta_milli, reason, ref_type, ref_id, created_at)
                 VALUES (?1, ?2, ?3, 'sync', ?4, ?5)",
                rusqlite::params![id, delta_milli, mv.reason, mv.external_id, mv.created_at],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE items SET stock_milli = stock_milli + ?2 WHERE id = ?1",
                rusqlite::params![id, delta_milli],
            )
            .map_err(|e| e.to_string())?;
            applied.push(AppliedRemoteMove {
                external_id: mv.external_id.clone(),
                item_id: Some(id),
                delta_milli,
                reason: mv.reason.clone(),
            });
        } else {
            applied.push(AppliedRemoteMove {
                external_id: mv.external_id.clone(),
                item_id: None,
                delta_milli: mv.delta_units * 1000,
                reason: mv.reason.clone(),
            });
        }
    }
    tx.execute(
        "INSERT INTO sync_state (key, value) VALUES ('stock_cursor', ?1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        rusqlite::params![cursor],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(applied)
}

// ---------------------------------------------------------------------------
// Remote catalog: price/stock links and the online-orders cache.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteItemPayload {
    pub external_id: String,
    #[allow(dead_code)]
    pub stock_units: i64,
    #[allow(dead_code)]
    pub price_paise: i64,
    /// Fingerprint of what the marketplace now holds for this item.
    pub remote_hash: String,
}

/// Record what the marketplace holds for each item we know about. Never
/// touches local price/stock — reconcile decides which side wins.
pub fn record_remote_catalog(conn: &Connection, items: &[RemoteItemPayload]) -> RepoResult<usize> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut linked = 0usize;
    for item in items {
        let hash = if item.remote_hash.trim().is_empty() {
            format!("{}:{}:{}", item.price_paise, item.stock_units, item.external_id)
        } else {
            item.remote_hash.clone()
        };
        let n = tx
            .execute(
                "UPDATE items SET remote_hash = ?2 WHERE remote_product_id = ?1 OR ('itm_' || id) = ?1",
                rusqlite::params![item.external_id, hash],
            )
            .map_err(|e| e.to_string())?;
        linked += n;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(linked)
}
