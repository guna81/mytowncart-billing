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
    #[allow(dead_code)]
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
                let delta = units * 1000 - current;
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
                tx.execute(
                    "UPDATE items SET is_active = 0 WHERE id = ?1",
                    rusqlite::params![fix.item_id],
                )
                .map_err(|e| e.to_string())?;
            }
            (true, other) => return Err(format!("cannot pull \"{other}\" to local")),
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
