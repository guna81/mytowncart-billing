// SPDX-License-Identifier: Apache-2.0
//! B5 — durable state for two-way sync: the app-settings JSON documents the UI
//! owns (backup schedule, pilot diagnostics, reconciliation reminders), the
//! `sync_state` cursors, and the stock outbox that must survive restarts.
//!
//! The web layer decides *what* to send; this module only guarantees that a
//! movement is enqueued exactly once (UNIQUE idempotency_key) and that a
//! remote feed page is applied together with its cursor in one transaction.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

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
    let inserted = enqueue_stock_outbox_in_transaction(&tx, moves)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

/// Insert into an existing transaction; its caller owns commit and rollback.
pub(crate) fn enqueue_stock_outbox_in_transaction(
    conn: &Connection,
    moves: &[(String, String)],
) -> RepoResult<Vec<String>> {
    let mut inserted = Vec::new();
    for (payload_json, key) in moves {
        if key.trim().is_empty() || payload_json.trim().is_empty() {
            return Err("an outbox row needs a payload and an idempotency key".to_string());
        }
        serde_json::from_str::<serde_json::Value>(payload_json)
            .map_err(|e| format!("outbox payload must be JSON: {e}"))?;
        let n = conn
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

/// Immutable one-source delivery plus an exclusive, expiring claim.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockDeliveryClaim {
    pub id: i64,
    pub payload_json: String,
    pub idempotency_key: String,
    pub claim_token: String,
    pub attempts: i64,
}

/// Prepare and claim the oldest eligible per-item movement atomically.
/// `now` and `claim_until` must be canonical UTC ISO timestamps.
#[allow(dead_code)]
pub fn claim_stock_delivery(conn: &Connection, now: &str, claim_until: &str) -> RepoResult<Option<StockDeliveryClaim>> {
    if claim_until <= now { return Err("claim expiry must follow now".into()); }
    let valid: bool = conn.query_row("SELECT julianday(?1) IS NOT NULL AND julianday(?2) IS NOT NULL",rusqlite::params![now,claim_until],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !valid || !now.ends_with('Z') || !claim_until.ends_with('Z') { return Err("invalid claim timestamp".into()); }
    let tx = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    // Quarantine malformed sources atomically; never coerce them into a retry.
    tx.execute("UPDATE outbox SET status='quarantined',quarantine_reason='Malformed stock source' WHERE status='pending' AND CASE WHEN json_valid(payload_json) THEN COALESCE(json_type(payload_json,'$.externalId')!='text' OR json_extract(payload_json,'$.externalId')='' OR json_type(payload_json,'$.deltaUnits')!='integer' OR json_extract(payload_json,'$.deltaUnits')=0 OR json_extract(payload_json,'$.reason') NOT IN ('sale','adjustment','order_cancel'),1) ELSE 1 END", []).map_err(|e|e.to_string())?;
    // Old quarantined rows block their item, even though they have no delivery.
    // A malformed row also blocks its item rather than being silently dropped.
    let source = tx.query_row(
        "SELECT o.id, o.payload_json FROM outbox o
         WHERE o.status = 'pending'
           AND json_valid(o.payload_json)
           AND NOT EXISTS (SELECT 1 FROM stock_reconciliations intent WHERE intent.external_id=json_extract(o.payload_json,'$.externalId') AND intent.status='pending')
           AND NOT EXISTS (SELECT 1 FROM stock_source_resolutions resolution WHERE resolution.external_id=json_extract(o.payload_json,'$.externalId') AND resolution.retired_by IS NULL)
           AND NOT EXISTS (SELECT 1 FROM outbox earlier
             WHERE earlier.id < o.id AND earlier.status IN ('pending','quarantined')
               AND json_valid(earlier.payload_json)
               AND json_extract(earlier.payload_json, '$.externalId') = json_extract(o.payload_json, '$.externalId'))
           AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?1)
           AND NOT EXISTS (SELECT 1 FROM stock_deliveries d WHERE d.outbox_id = o.id
             AND (d.status = 'done' OR (d.next_attempt_at IS NOT NULL AND d.next_attempt_at > ?1)
               OR (d.claim_until IS NOT NULL AND d.claim_until > ?1)))
         ORDER BY o.id LIMIT 1", [now], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    );
    let (source_id, source_json) = match source {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => { tx.commit().map_err(|e| e.to_string())?; return Ok(None); },
        Err(e) => return Err(e.to_string()),
    };
    let source: serde_json::Value = serde_json::from_str(&source_json).map_err(|e| e.to_string())?;
    let external = source.get("externalId").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).ok_or("invalid externalId")?;
    let delta = source.get("deltaUnits").and_then(|v| v.as_i64()).filter(|n| *n != 0).ok_or("invalid deltaUnits")?;
    let reason = source.get("reason").and_then(|v|v.as_str()).ok_or("invalid stock reason")?;
    let key: String = tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let mut payload = serde_json::json!({"externalId":external,"deltaUnits":delta,"reason":reason,"idempotencyKey":key,"createdAt":source.get("createdAt").and_then(|v|v.as_str()).unwrap_or(now)});
    let state: Option<String> = tx.query_row("SELECT state_json FROM stock_protocol_states WHERE external_id=?1", [external], |r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(raw) = state {
        let state: crate::stock_protocol::StockProtocolState = serde_json::from_str(&raw).map_err(|e|e.to_string())?;
        payload["epoch"]=state.epoch.into(); payload["variantId"]=state.variant_id.into(); payload["generation"]=state.generation.into();
    }
    let payload = payload.to_string();
    tx.execute("INSERT OR IGNORE INTO stock_deliveries(outbox_id, external_id, payload_json, idempotency_key) VALUES (?1, ?2, ?3, ?4)", rusqlite::params![source_id, external, payload, key]).map_err(|e| e.to_string())?;
    let token: String = tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    tx.execute("UPDATE stock_deliveries SET claim_token = ?1, claim_until = ?2 WHERE outbox_id = ?3", rusqlite::params![token, claim_until, source_id]).map_err(|e| e.to_string())?;
    let claim = tx.query_row("SELECT id, payload_json, idempotency_key, claim_token, attempts FROM stock_deliveries WHERE outbox_id = ?1", [source_id], |r| Ok(StockDeliveryClaim { id: r.get(0)?, payload_json: r.get(1)?, idempotency_key: r.get(2)?, claim_token: r.get(3)?, attempts: r.get(4)? })).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(claim))
}

/// Acknowledge or schedule one claimed delivery and its exact source together.
#[allow(dead_code)]
pub fn settle_stock_delivery(conn: &Connection, id: i64, token: &str, outcome: &str, retry_at: Option<&str>, detail: Option<&str>) -> RepoResult<()> {
    if !["done","retry","quarantined"].contains(&outcome) { return Err("invalid stock delivery outcome".into()); }
    if outcome == "retry" && retry_at.is_none() { return Err("retry requires nextAttemptAt".into()); }
    let tx = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let source: i64 = tx.query_row("SELECT outbox_id FROM stock_deliveries WHERE id = ?1 AND status = 'pending' AND claim_token = ?2", rusqlite::params![id, token], |r| r.get(0)).map_err(|e| format!("stale or missing stock delivery claim: {e}"))?;
    if outcome == "quarantined" {
        tx.execute("UPDATE outbox SET status='quarantined',quarantine_reason=?2,attempts=attempts+1 WHERE id=?1 AND status='pending'", rusqlite::params![source,detail.unwrap_or("Unknown or permanent stock outcome")]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE stock_deliveries SET status='quarantined',outcome_detail=?2,claim_token=NULL,claim_until=NULL,attempts=attempts+1 WHERE id=?1",rusqlite::params![id,detail]).map_err(|e|e.to_string())?;
    } else if let Some(retry) = retry_at.filter(|_|outcome == "retry") {
        tx.execute("UPDATE stock_deliveries SET attempts = attempts + 1, next_attempt_at = ?1, claim_token = NULL, claim_until = NULL WHERE id = ?2", rusqlite::params![retry, id]).map_err(|e| e.to_string())?;
    } else {
        let n = tx.execute("UPDATE outbox SET status = 'done', attempts = attempts + 1, next_attempt_at = NULL WHERE id = ?1 AND status = 'pending'", [source]).map_err(|e| e.to_string())?;
        if n != 1 { return Err("stock delivery source is not pending".into()); }
        tx.execute("UPDATE stock_deliveries SET status = 'done', attempts = attempts + 1, next_attempt_at = NULL, claim_token = NULL, claim_until = NULL WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
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
        if outcome == "retry" && next_attempt_at.is_none() {
            return Err("a retry needs a next_attempt_at".to_string());
        }
        let protected: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM outbox o WHERE o.idempotency_key=?1 AND (o.status='quarantined' OR EXISTS(SELECT 1 FROM stock_deliveries d WHERE d.outbox_id=o.id)))",[key],|r|r.get(0)).map_err(|e|e.to_string())?;
        if protected { return Err("stock source requires delivery settlement or explicit reconciliation".into()); }
        // Match terminal rows too, but never let a late retry resurrect one.
        let n = if outcome == "done" {
            tx.execute(
                "UPDATE outbox SET attempts = attempts + CASE WHEN status = 'pending' THEN 1 ELSE 0 END,
                    status = 'done', next_attempt_at = NULL WHERE idempotency_key = ?1",
                rusqlite::params![key],
            )
            .map_err(|e| e.to_string())?
        } else {
            tx.execute(
                "UPDATE outbox SET attempts = attempts + CASE WHEN status = 'pending' THEN 1 ELSE 0 END,
                    next_attempt_at = CASE WHEN status = 'pending' THEN ?2 ELSE next_attempt_at END
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
        let protected: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM outbox o WHERE o.idempotency_key=?1 AND (o.status!='done' OR EXISTS(SELECT 1 FROM stock_deliveries d WHERE d.outbox_id=o.id)))",[key],|r|r.get(0)).map_err(|e|e.to_string())?;
        if protected { return Err("cannot discard pending or quarantined stock sources".into()); }
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
    pub epoch: Option<String>,
    pub sequence: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppliedRemoteMove {
    pub external_id: String,
    pub item_id: Option<i64>,
    pub delta_milli: i64,
    pub reason: String,
}

const PULL_REASONS: &[&str] = &["online_order", "order_cancel", "adjustment", "import"];

/// Apply one page of the marketplace stock feed as local `sync` movements
/// (one per unit traded) and advance the cursor in the SAME transaction, so a
/// crash can never re-apply a page or skip one. An external id we cannot
/// resolve is reported back, never invented; the server's cursor already
/// guarantees each movement id is seen once.
pub fn apply_stock_pull(
    conn: &mut Connection,
    expected_cursor: Option<&str>,
    cursor: &str,
    moves: &[RemoteStockMovePayload],
) -> RepoResult<Vec<AppliedRemoteMove>> {
    if expected_cursor == Some(cursor) {
        return Err("stock pull cursor must advance".to_string());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let current = get_cursor(&tx, "stock_cursor")?;
    if current.as_deref() != expected_cursor {
        return Err("stock pull cursor changed; retry sync".to_string());
    }
    if let Some(epoch) = get_setting(&tx,"sync.stock_epoch")? {
        let missing: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM items i WHERE i.remote_product_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM stock_protocol_states s WHERE (s.external_id=i.remote_product_id OR s.external_id=('itm_'||i.id)) AND json_extract(s.state_json,'$.epoch')=?1))",[&epoch],|r|r.get(0)).map_err(|e|e.to_string())?;
        if missing { return Err("new linked item requires stock baseline before feed application".into()); }
        if moves.iter().any(|m|m.epoch.as_deref()!=Some(epoch.as_str()) || m.sequence.is_none()) { return Err("stock feed epoch mismatch or sequence missing".into()); }
    }
    let mut applied = Vec::new();
    for mv in moves {
        let pending = crate::stock_protocol::unresolved(&tx,Some(&mv.external_id))?;
        if pending { return Err("stock reconciliation pending; recover before pulling this item".into()); }
        let baseline: Option<String> = tx.query_row("SELECT state_json FROM stock_protocol_states WHERE external_id=?1", [&mv.external_id], |r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(raw) = baseline {
            let state: crate::stock_protocol::StockProtocolState = serde_json::from_str(&raw).map_err(|e|e.to_string())?;
            if mv.epoch.as_deref() != Some(&state.epoch) { return Err("stock feed epoch mismatch; explicit bootstrap required".into()); }
            let sequence = mv.sequence.ok_or("stock feed sequence required")?;
            if sequence <= state.sequence { continue; }
        }
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

#[cfg(test)]
mod pull_tests {
    use super::*;
    use std::{sync::{Arc, Barrier}, thread, time::Duration};

    #[test]
    fn concurrent_pull_pages_only_apply_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pull.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE stock_reconciliations (external_id TEXT, status TEXT);
            CREATE TABLE stock_source_resolutions (external_id TEXT, retired_by TEXT);
            CREATE TABLE stock_protocol_states (external_id TEXT PRIMARY KEY,state_json TEXT);
            CREATE TABLE items (id INTEGER PRIMARY KEY, remote_product_id TEXT, stock_milli INTEGER);
            CREATE TABLE stock_movements (item_id INTEGER, delta_milli INTEGER, reason TEXT, ref_type TEXT, ref_id TEXT, created_at TEXT);
            INSERT INTO items VALUES (1, NULL, 2000);").unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = (0..2).map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                let mut conn = Connection::open(path).unwrap();
                conn.busy_timeout(Duration::from_secs(5)).unwrap();
                let moves = [RemoteStockMovePayload { external_id: "itm_1".into(), delta_units: -1, reason: "online_order".into(), created_at: "now".into(), epoch: None, sequence: None }];
                barrier.wait();
                apply_stock_pull(&mut conn, None, "1", &moves)
            })
        }).collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert!(results.iter().any(|r| r.as_ref().err().is_some_and(|e| e.contains("cursor changed"))));
        let state: (i64, i64, String) = conn.query_row("SELECT stock_milli, (SELECT COUNT(*) FROM stock_movements), (SELECT value FROM sync_state WHERE key = 'stock_cursor') FROM items", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(state, (1000, 1, "1".into()));
        let mut conn = conn;
        assert!(apply_stock_pull(&mut conn, Some("1"), "1", &[]).is_err());
        assert!(apply_stock_pull(&mut conn, Some("1"), "2", &[]).is_ok());
    }
}
