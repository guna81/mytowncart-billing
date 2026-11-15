// SPDX-License-Identifier: Apache-2.0
//! B5 reconcile (roadmap §8.6): the seller decides which side wins per row.
//!
//! "Local wins" never sends a stock delta (that would be applied on top of
//! whatever the marketplace holds); it clears the item's publish hash so the
//! next catalog push sends the authoritative local price and stock. "Remote
//! wins" writes the remote values locally, with stock recorded as a normal
//! `adjustment` movement so the ledger stays the single source of truth.

use rusqlite::{Connection, TransactionBehavior};

use crate::repo::RepoResult;

pub const RECONCILE_KINDS: &[&str] = &["stock", "price", "missing_remote", "remote_inactive"];

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileFixPayload {
    pub item_id: i64,
    pub external_id: String,
    pub kind: String,
    pub price_paise: Option<i64>,
    pub stock_units: Option<i64>,
    pub is_active: Option<bool>,
    pub pull_to_local: bool,
}

pub fn apply_reconcile_fixes(conn: &mut Connection, fixes: &[ReconcileFixPayload]) -> RepoResult<()> {
    for fix in fixes {
        if !RECONCILE_KINDS.contains(&fix.kind.as_str()) {
            return Err(format!("bad reconcile kind \"{}\"", fix.kind));
        }
        if fix.kind == "missing_remote" && fix.pull_to_local {
            return Err("a missing marketplace item can only be pushed".to_string());
        }
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    // Check under the same write lock as the fixes. LAN sales can enqueue on a
    // different connection, so a check performed by the UI is not sufficient.
    for fix in fixes.iter().filter(|f| f.kind == "stock" || f.kind == "missing_remote") {
        let pending: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox WHERE status IN ('pending','quarantined') AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.externalId')=?1 ELSE 0 END) OR EXISTS(SELECT 1 FROM stock_reconciliations WHERE external_id=?1 AND status='pending')",
            [&fix.external_id], |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        if pending { return Err("Cannot reconcile while conflicting stock changes are pending sync".into()); }
        if fix.kind == "stock" { return Err("stock reconciliation requires a durable protocol operation".into()); }
    }
    for fix in fixes {
        let exists: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM items WHERE id = ?1 AND (remote_product_id = ?2 OR ('itm_' || id) = ?2)",
                rusqlite::params![fix.item_id, fix.external_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            return Err(format!(
                "item {} is not linked to {}",
                fix.item_id, fix.external_id
            ));
        }
        match (fix.pull_to_local, fix.kind.as_str()) {
            (false, "missing_remote") => {
                tx.execute(
                    "UPDATE items SET remote_product_id = NULL, remote_variant_id = NULL,
                            content_hash = NULL, remote_hash = NULL, publish_state = 'local_only'
                     WHERE id = ?1",
                    rusqlite::params![fix.item_id],
                )
                .map_err(|e| e.to_string())?;
            }
            (false, _) => {
                // Catalog push carries local price + stock; force a re-send.
                tx.execute(
                    "UPDATE items SET content_hash = NULL WHERE id = ?1",
                    rusqlite::params![fix.item_id],
                )
                .map_err(|e| e.to_string())?;
            }
            (true, "price") => {
                let price = fix.price_paise.ok_or("a remote price is required")?;
                if price < 0 {
                    return Err("price must be >= 0".to_string());
                }
                tx.execute(
                    "UPDATE items SET price_paise = ?2 WHERE id = ?1",
                    rusqlite::params![fix.item_id, price],
                )
                .map_err(|e| e.to_string())?;
            }
            (true, "stock") => {
                let units = fix.stock_units.ok_or("a remote stock count is required")?;
                if units < 0 {
                    return Err("stock must be >= 0".to_string());
                }
                let current: i64 = tx
                    .query_row(
                        "SELECT stock_milli FROM items WHERE id = ?1",
                        rusqlite::params![fix.item_id],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                let delta = units
                    .checked_mul(1000)
                    .and_then(|target| target.checked_sub(current))
                    .ok_or("stock count is too large")?;
                if delta != 0 {
                    tx.execute(
                        "INSERT INTO stock_movements (item_id, delta_milli, reason, ref_type, ref_id, created_at)
                         VALUES (?1, ?2, 'adjustment', 'reconcile', ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                        rusqlite::params![fix.item_id, delta, fix.external_id],
                    )
                    .map_err(|e| e.to_string())?;
                    tx.execute(
                        "UPDATE items SET stock_milli = stock_milli + ?2 WHERE id = ?1",
                        rusqlite::params![fix.item_id, delta],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            (true, "remote_inactive") => {
                let is_active = fix.is_active.ok_or("a remote active state is required")?;
                tx.execute(
                    "UPDATE items SET is_active = ?2 WHERE id = ?1",
                    rusqlite::params![fix.item_id, is_active],
                )
                .map_err(|e| e.to_string())?;
            }
            (true, other) => return Err(format!("cannot pull \"{other}\" to local")),
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, remote_product_id TEXT, remote_variant_id TEXT,
             content_hash TEXT, remote_hash TEXT, publish_state TEXT, price_paise INTEGER, stock_milli INTEGER, is_active INTEGER);
             CREATE TABLE stock_movements (item_id INTEGER, delta_milli INTEGER, reason TEXT, ref_type TEXT, ref_id TEXT, created_at TEXT);
             CREATE TABLE outbox (status TEXT NOT NULL, payload_json TEXT DEFAULT '{\"externalId\":\"itm_1\"}');
             CREATE TABLE stock_reconciliations (external_id TEXT, status TEXT);
             INSERT INTO items (id, price_paise, stock_milli, is_active) VALUES (1, 100, 2000, 0);",
        ).unwrap();
        conn
    }

    fn fix(kind: &str) -> ReconcileFixPayload {
        ReconcileFixPayload { item_id: 1, external_id: "itm_1".into(), kind: kind.into(),
            price_paise: None, stock_units: None, is_active: None, pull_to_local: true }
    }

    #[test]
    fn pulls_active_state_and_records_stock_once() {
        let mut conn = setup();
        let mut stock = fix("stock");
        stock.stock_units = Some(4);
        let mut active = fix("remote_inactive");
        active.is_active = Some(true);
        assert!(apply_reconcile_fixes(&mut conn, &[stock.clone(), active.clone()]).unwrap_err().contains("durable protocol"));
        apply_reconcile_fixes(&mut conn, &[active]).unwrap();
        let row: (i64, i64) = conn.query_row("SELECT stock_milli, is_active FROM items", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(row, (2000, 1));
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM stock_movements", [], |r|r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn pending_outbox_blocks_entire_batch_but_done_does_not() {
        let mut conn = setup();
        conn.execute("INSERT INTO outbox(status) VALUES ('pending')", []).unwrap();
        let mut stock = fix("stock");
        stock.stock_units = Some(5);
        assert!(apply_reconcile_fixes(&mut conn, &[stock.clone()]).unwrap_err().contains("pending sync"));
        let state: (i64, i64) = conn.query_row(
            "SELECT stock_milli, (SELECT COUNT(*) FROM stock_movements) FROM items", [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(state, (2000, 0));
        conn.execute("UPDATE outbox SET status = 'done'", []).unwrap();
        assert!(apply_reconcile_fixes(&mut conn, &[stock]).unwrap_err().contains("durable protocol"));
    }

    #[test]
    fn pending_lan_write_is_checked_after_its_transaction_commits() {
        use std::{sync::mpsc, thread, time::Duration};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("billing.db");
        let mut lan = Connection::open(&path).unwrap();
        lan.execute_batch(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, remote_product_id TEXT, stock_milli INTEGER);
             CREATE TABLE stock_movements (item_id INTEGER, delta_milli INTEGER, reason TEXT, ref_type TEXT, ref_id TEXT, created_at TEXT);
             CREATE TABLE outbox (status TEXT NOT NULL, payload_json TEXT DEFAULT '{\"externalId\":\"itm_1\"}');
             CREATE TABLE stock_reconciliations (external_id TEXT, status TEXT);
             INSERT INTO items VALUES (1, NULL, 2000);"
        ).unwrap();
        let tx = lan.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
        tx.execute("INSERT INTO outbox(status) VALUES ('pending')", []).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            let mut conn = Connection::open(path).unwrap();
            conn.busy_timeout(Duration::from_secs(5)).unwrap();
            let mut stock = fix("stock");
            stock.stock_units = Some(5);
            started_tx.send(()).unwrap();
            result_tx.send(apply_reconcile_fixes(&mut conn, &[stock])).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(matches!(result_rx.recv_timeout(Duration::from_millis(100)), Err(mpsc::RecvTimeoutError::Timeout)));
        tx.commit().unwrap();
        assert!(result_rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap_err().contains("pending sync"));
        handle.join().unwrap();
        let stock: i64 = lan.query_row("SELECT stock_milli FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(stock, 2000);
    }

    #[test]
    fn invalid_pull_rolls_back_batch() {
        let mut conn = setup();
        let mut stock = fix("stock");
        stock.stock_units = Some(5);
        for invalid in [fix("remote_inactive"), fix("price"), {
            let mut overflow = fix("stock");
            overflow.stock_units = Some(i64::MAX);
            overflow
        }] {
            assert!(apply_reconcile_fixes(&mut conn, &[stock.clone(), invalid]).is_err());
            let value: i64 = conn.query_row("SELECT stock_milli FROM items", [], |r| r.get(0)).unwrap();
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM stock_movements", [], |r| r.get(0)).unwrap();
            assert_eq!((value, count), (2000, 0));
        }
    }
}
