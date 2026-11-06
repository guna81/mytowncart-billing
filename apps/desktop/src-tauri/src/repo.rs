// SPDX-License-Identifier: Apache-2.0
//! Storage commands backing `packages/storage`'s Tauri adapter.
//!
//! Architecture (roadmap §8.1, DECISIONS.md B0-1): the web UI never runs
//! writes itself. Every multi-table write is a dedicated function here that
//! runs in ONE rusqlite transaction, receiving a fully-computed payload
//! from the TypeScript domain layer (`@mytowncart-billing/core`). Reads go
//! through the generic parameterized [`query_rows`] helper.
//!
//! Invoice numbers are allocated inside the bill-save transaction under
//! BEGIN IMMEDIATE so they are sequential and gap-free per financial year.

use rusqlite::{types::Value, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

pub type RepoResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Generic parameterized read helper (reads only).
// ---------------------------------------------------------------------------

pub fn query_rows(
    conn: &Connection,
    sql: &str,
    params: Vec<serde_json::Value>,
) -> RepoResult<Vec<serde_json::Map<String, serde_json::Value>>> {
    let mut stmt = conn.prepare(sql).map_err(err)?;
    let bind: Vec<Value> = params.iter().map(json_to_sqlite).collect();
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(bind), |row| {
            let mut map = serde_json::Map::new();
            for (i, name) in columns.iter().enumerate() {
                map.insert(name.clone(), sqlite_to_json(row.get_ref(i)?));
            }
            Ok(map)
        })
        .map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

fn json_to_sqlite(v: &serde_json::Value) -> Value {
    match v {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else {
                Value::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

fn sqlite_to_json(v: rusqlite::types::ValueRef<'_>) -> serde_json::Value {
    match v {
        rusqlite::types::ValueRef::Null => serde_json::Value::Null,
        rusqlite::types::ValueRef::Integer(i) => serde_json::Value::Number(i.into()),
        rusqlite::types::ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        rusqlite::types::ValueRef::Text(t) => {
            serde_json::Value::String(String::from_utf8_lossy(t).into_owned())
        }
        rusqlite::types::ValueRef::Blob(b) => serde_json::Value::String(format!("<blob {} bytes>", b.len())),
    }
}

// ---------------------------------------------------------------------------
// Shop profile (single-row table, id = 1).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopProfilePayload {
    pub name: String,
    pub gst_enabled: bool,
    pub prices_include_tax: bool,
    pub invoice_prefix: String,
    pub address: String,
    pub phone: String,
    pub gstin: String,
    pub receipt_footer: String,
    pub low_stock_threshold_milli: i64,
    pub updated_at: String,
}

pub fn save_shop_profile(conn: &Connection, p: &ShopProfilePayload) -> RepoResult<()> {
    conn.execute(
        "INSERT INTO shop_profile
           (id, name, gst_enabled, prices_include_tax, invoice_prefix, address, phone, gstin,
            receipt_footer, low_stock_threshold_milli, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           gst_enabled = excluded.gst_enabled,
           prices_include_tax = excluded.prices_include_tax,
           invoice_prefix = excluded.invoice_prefix,
           address = excluded.address,
           phone = excluded.phone,
           gstin = excluded.gstin,
           receipt_footer = excluded.receipt_footer,
           low_stock_threshold_milli = excluded.low_stock_threshold_milli,
           updated_at = excluded.updated_at",
        rusqlite::params![
            p.name,
            p.gst_enabled as i64,
            p.prices_include_tax as i64,
            p.invoice_prefix,
            p.address,
            p.phone,
            p.gstin,
            p.receipt_footer,
            p.low_stock_threshold_milli,
            p.updated_at,
        ],
    )
    .map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Categories / customers (single-row writes).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryPayload {
    pub id: Option<i64>,
    pub name: String,
}

pub fn upsert_category(conn: &Connection, c: &CategoryPayload) -> RepoResult<i64> {
    if c.name.trim().is_empty() {
        return Err("category name is required".to_string());
    }
    match c.id {
        Some(id) => {
            conn.execute("UPDATE categories SET name = ?2 WHERE id = ?1", rusqlite::params![id, c.name])
                .map_err(err)?;
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO categories (name) VALUES (?1) ON CONFLICT (name) DO NOTHING",
                rusqlite::params![c.name],
            )
            .map_err(err)?;
            let id: i64 = conn
                .query_row("SELECT id FROM categories WHERE name = ?1", rusqlite::params![c.name], |r| r.get(0))
                .map_err(err)?;
            Ok(id)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerPayload {
    pub id: Option<i64>,
    pub name: String,
    pub phone: String,
    #[serde(default)]
    pub gstin: String,
    #[serde(default)]
    pub address: String,
    pub now: String,
}

pub fn upsert_customer(conn: &Connection, c: &CustomerPayload) -> RepoResult<i64> {
    if c.name.trim().is_empty() {
        return Err("customer name is required".to_string());
    }
    match c.id {
        Some(id) => {
            conn.execute(
                "UPDATE customers SET name = ?2, phone = ?3, gstin = ?4, address = ?5, updated_at = ?6 WHERE id = ?1",
                rusqlite::params![id, c.name, c.phone, c.gstin, c.address, c.now],
            )
            .map_err(err)?;
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO customers (name, phone, gstin, address, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                rusqlite::params![c.name, c.phone, c.gstin, c.address, c.now],
            )
            .map_err(err)?;
            Ok(conn.last_insert_rowid())
        }
    }
}

pub fn delete_customer(conn: &Connection, customer_id: i64) -> RepoResult<bool> {
    let bill_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM bills WHERE customer_id = ?1",
            rusqlite::params![customer_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if bill_count > 0 {
        return Err("cannot delete customer with existing bills".to_string());
    }
    let payment_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM customer_payments WHERE customer_id = ?1",
            rusqlite::params![customer_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if payment_count > 0 {
        return Err("cannot delete customer with existing payment records".to_string());
    }
    let affected = conn
        .execute("DELETE FROM customers WHERE id = ?1", rusqlite::params![customer_id])
        .map_err(err)?;
    Ok(affected > 0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerPaymentPayload {
    pub customer_id: i64,
    pub amount_paise: i64,
    pub mode: String,
    #[serde(default)]
    pub notes: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerPaymentRow {
    pub id: i64,
    pub customer_id: i64,
    pub amount_paise: i64,
    pub mode: String,
    pub notes: String,
    pub created_at: String,
}

pub fn record_customer_payment(conn: &Connection, p: &CustomerPaymentPayload) -> RepoResult<i64> {
    if p.amount_paise <= 0 {
        return Err("payment amount must be positive".to_string());
    }
    if !matches!(p.mode.as_str(), "cash" | "upi" | "card" | "bank") {
        return Err(format!("bad payment mode \"{}\"", p.mode));
    }
    conn.execute(
        "INSERT INTO customer_payments (customer_id, amount_paise, mode, notes, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![p.customer_id, p.amount_paise, p.mode, p.notes, p.created_at],
    )
    .map_err(err)?;
    Ok(conn.last_insert_rowid())
}

pub fn list_customer_payments(conn: &Connection, customer_id: i64) -> RepoResult<Vec<CustomerPaymentRow>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, customer_id, amount_paise, mode, notes, created_at
             FROM customer_payments
             WHERE customer_id = ?1
             ORDER BY created_at ASC, id ASC",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map(rusqlite::params![customer_id], |r| {
            Ok(CustomerPaymentRow {
                id: r.get(0)?,
                customer_id: r.get(1)?,
                amount_paise: r.get(2)?,
                mode: r.get(3)?,
                notes: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Items.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPayload {
    pub id: Option<i64>,
    pub name: String,
    pub barcode: String,
    pub category_id: Option<i64>,
    pub unit_kind: String,
    pub price_paise: i64,
    pub mrp_paise: i64,
    pub tax_rate_bp: i64,
    /// Opening stock in milli-units; applied ONLY when inserting a new item
    /// (writes an 'opening' stock movement and the cached sum).
    pub opening_stock_milli: i64,
    pub is_active: bool,
    #[serde(default)]
    pub hsn_code: String,
    #[serde(default)]
    pub cost_price_paise: i64,
    pub now: String,
}

fn validate_item(p: &ItemPayload) -> RepoResult<()> {
    if p.name.trim().is_empty() {
        return Err("item name is required".to_string());
    }
    if !matches!(p.unit_kind.as_str(), "count" | "weight" | "volume") {
        return Err(format!("bad unit_kind \"{}\"", p.unit_kind));
    }
    if p.price_paise < 0 || p.mrp_paise < 0 || p.tax_rate_bp < 0 || p.tax_rate_bp > 10_000 {
        return Err("price/mrp must be >= 0 and tax_rate_bp within 0..=10000".to_string());
    }
    Ok(())
}

/// Upsert one item inside the caller's transaction context. When `tx_per_item`
/// semantics are wanted (CSV import), the caller wraps each call in its own tx.
fn upsert_item_inner(conn: &Connection, p: &ItemPayload) -> RepoResult<i64> {
    validate_item(p)?;
    match p.id {
        Some(id) => {
            let changed = conn
                .execute(
                    "UPDATE items SET name = ?2, barcode = ?3, category_id = ?4, unit_kind = ?5,
                       price_paise = ?6, mrp_paise = ?7, tax_rate_bp = ?8, is_active = ?9,
                       hsn_code = ?10, cost_price_paise = ?11, updated_at = ?12
                     WHERE id = ?1",
                    rusqlite::params![
                        id, p.name, p.barcode, p.category_id, p.unit_kind, p.price_paise,
                        p.mrp_paise, p.tax_rate_bp, p.is_active as i64, p.hsn_code, p.cost_price_paise, p.now,
                    ],
                )
                .map_err(err)?;
            if changed == 0 {
                return Err(format!("no item with id {id}"));
            }
            Ok(id)
        }
        None => {
            // A non-empty barcode that already exists updates that item —
            // re-importing a CSV must not create duplicates.
            if !p.barcode.is_empty() {
                let existing: Option<i64> = conn
                    .query_row(
                        "SELECT id FROM items WHERE barcode = ?1 AND barcode != ''",
                        rusqlite::params![p.barcode],
                        |r| r.get(0),
                    )
                    .ok();
                if let Some(id) = existing {
                    return upsert_item_inner(conn, &ItemPayload { id: Some(id), opening_stock_milli: 0, ..p.clone() });
                }
            }
            conn.execute(
                "INSERT INTO items (name, barcode, category_id, unit_kind, price_paise, mrp_paise,
                   tax_rate_bp, stock_milli, is_active, hsn_code, cost_price_paise, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11)",
                rusqlite::params![
                    p.name, p.barcode, p.category_id, p.unit_kind, p.price_paise, p.mrp_paise,
                    p.tax_rate_bp, p.is_active as i64, p.hsn_code, p.cost_price_paise, p.now,
                ],
            )
            .map_err(err)?;
            let id = conn.last_insert_rowid();
            if p.opening_stock_milli != 0 {
                insert_movement(conn, id, p.opening_stock_milli, "opening", None, None, &p.now)?;
            }
            Ok(id)
        }
    }
}

pub fn upsert_item(conn: &mut Connection, p: &ItemPayload) -> RepoResult<i64> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let id = upsert_item_inner(&tx, p)?;
    tx.commit().map_err(err)?;
    Ok(id)
}

/// Persist one item's photo file name + its hash (B2/D9). The bytes were
/// already written by `media::store_photo`; the file is removed again if the
/// row update fails so no orphan is left behind.
pub fn set_item_photo(
    conn: &Connection,
    data_dir: &std::path::Path,
    item_id: i64,
    bytes: &[u8],
    image_hash: &str,
    now: &str,
) -> RepoResult<String> {
    if image_hash.is_empty() {
        return Err("image_hash is required".to_string());
    }
    let file_name = crate::media::store_photo(data_dir, item_id, bytes)?;
    let changed = conn
        .execute(
            "UPDATE items SET photo_path = ?2, image_hash = ?3, image_uploaded_at = NULL,
                    updated_at = ?4
             WHERE id = ?1",
            rusqlite::params![item_id, file_name, image_hash, now],
        )
        .map_err(err)?;
    if changed == 0 {
        let _ = crate::media::delete_photo(data_dir, &file_name);
        return Err(format!("no item with id {item_id}"));
    }
    Ok(file_name)
}

pub fn clear_item_photo(
    conn: &Connection,
    data_dir: &std::path::Path,
    item_id: i64,
    now: &str,
) -> RepoResult<()> {
    let previous: Option<String> = conn
        .query_row(
            "SELECT photo_path FROM items WHERE id = ?1",
            rusqlite::params![item_id],
            |r| r.get(0),
        )
        .map_err(|_| format!("no item with id {item_id}"))?;
    conn.execute(
        "UPDATE items SET photo_path = '', image_hash = NULL, image_uploaded_at = NULL,
                updated_at = ?2
         WHERE id = ?1",
        rusqlite::params![item_id, now],
    )
    .map_err(err)?;
    if let Some(name) = previous.filter(|n| !n.is_empty()) {
        crate::media::delete_photo(data_dir, &name)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageUploadPayload {
    pub item_id: i64,
    pub image_hash: String,
    pub uploaded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxMovePayload {
    pub payload_json: String,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxResultPayload {
    pub idempotency_key: String,
    pub outcome: String,
    pub next_attempt_at: Option<String>,
}

/// Image uploads reported by the marketplace (one transaction per run).
pub fn record_image_uploads(
    conn: &Connection,
    uploads: &[(i64, String, String)],
) -> RepoResult<()> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    for (item_id, image_hash, uploaded_at) in uploads {
        if uploaded_at.is_empty() {
            return Err("uploaded_at is required".to_string());
        }
        // Matching on image_hash makes a stale acknowledgement (photo replaced
        // while the upload was in flight) a no-op instead of a wrong state.
        tx.execute(
            "UPDATE items SET image_uploaded_at = ?3 WHERE id = ?1 AND image_hash = ?2",
            rusqlite::params![item_id, image_hash, uploaded_at],
        )
        .map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRowResult {
    pub index: usize,
    pub ok: bool,
    pub id: Option<i64>,
    pub error: Option<String>,
}

/// CSV bulk import: each row in its OWN transaction, so one bad row never
/// fails the batch (roadmap B1).
pub fn import_items(conn: &mut Connection, items: &[ItemPayload]) -> RepoResult<Vec<ImportRowResult>> {
    let mut results = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let tx = conn.transaction().map_err(err)?;
        let outcome = upsert_item_inner(&tx, item);
        match outcome {
            Ok(id) => {
                tx.commit().map_err(err)?;
                results.push(ImportRowResult { index, ok: true, id: Some(id), error: None });
            }
            Err(e) => {
                // tx drops uncommitted -> row rolled back, batch continues.
                results.push(ImportRowResult { index, ok: false, id: None, error: Some(e) });
            }
        }
    }
    Ok(results)
}

// ---------------------------------------------------------------------------
// Stock.
// ---------------------------------------------------------------------------

/// Enqueue this movement for the marketplace in the caller's transaction
/// (roadmap §8.6 key format). Items that were never published, and movements
/// the marketplace caused, never enter the outbox.
pub fn enqueue_movement(
    conn: &Connection,
    item_id: i64,
    movement_id: i64,
    delta_milli: i64,
    reason: &str,
    ref_id: Option<&str>,
) -> RepoResult<()> {
    if delta_milli == 0 {
        return Ok(());
    }
    let external_id: Option<String> = conn
        .query_row(
            "SELECT remote_product_id FROM items WHERE id = ?1 AND remote_product_id IS NOT NULL",
            rusqlite::params![item_id],
            |r| r.get(0),
        )
        .ok();
    let Some(external_id) = external_id else {
        return Ok(());
    };
    if !matches!(reason, "sale" | "void" | "adjustment" | "purchase") {
        return Ok(());
    }
    // Only whole pieces can be represented remotely; a fractional ledger delta
    // (for example a miscounted by-weight item) stays local instead of pushing
    // a truncated number the marketplace would treat as a real sale.
    if delta_milli % 1000 != 0 {
        return Ok(());
    }
    let key = if reason == "adjustment" || reason == "purchase" {
        format!("adj:{movement_id}")
    } else {
        format!("bill:{}:{movement_id}", ref_id.unwrap_or("-"))
    };
    let reason_code = match reason {
        "sale" => "sale",
        "void" => "order_cancel",
        _ => "adjustment",
    };
    let payload = serde_json::json!({
        "externalId": external_id,
        "deltaUnits": delta_milli / 1000,
        "reason": reason_code,
    });
    crate::sync::enqueue_stock_outbox(conn, &[(payload.to_string(), key)])?;
    Ok(())
}

fn insert_movement(
    conn: &Connection,
    item_id: i64,
    delta_milli: i64,
    reason: &str,
    ref_type: Option<&str>,
    ref_id: Option<&str>,
    created_at: &str,
) -> RepoResult<i64> {
    conn.execute(
        "INSERT INTO stock_movements (item_id, delta_milli, reason, ref_type, ref_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![item_id, delta_milli, reason, ref_type, ref_id, created_at],
    )
    .map_err(err)?;
    let movement_id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE items SET stock_milli = stock_milli + ?2 WHERE id = ?1",
        rusqlite::params![item_id, delta_milli],
    )
    .map_err(err)?;
    Ok(movement_id)
}

/// Manual stock adjustment: movement + cached sum in ONE transaction.
pub fn adjust_stock(
    conn: &mut Connection,
    item_id: i64,
    delta_milli: i64,
    reason: &str,
    created_at: &str,
) -> RepoResult<i64> {
    if delta_milli == 0 {
        return Err("an adjustment must change the stock".to_string());
    }
    if !matches!(reason, "adjustment" | "purchase" | "import") {
        return Err(format!("bad adjustment reason \"{reason}\""));
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let exists: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM items WHERE id = ?1",
            rusqlite::params![item_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if exists == 0 {
        return Err(format!("no item with id {item_id}"));
    }
    let movement_id = insert_movement(&tx, item_id, delta_milli, reason, Some("adjustment"), None, created_at)?;
    enqueue_movement(&tx, item_id, movement_id, delta_milli, reason, None)?;
    tx.commit().map_err(err)?;
    Ok(movement_id)
}

// ---------------------------------------------------------------------------
// Publish results (B2): link items to their marketplace products.
// ---------------------------------------------------------------------------

pub const PUBLISH_STATES: &[&str] = &[
    "local_only", "queued", "live", "hidden", "pending_store_approval", "error",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutcomePayload {
    pub item_id: i64,
    pub state: String,
    pub updated_at: String,
    pub remote_product_id: Option<String>,
    pub remote_variant_id: Option<String>,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMappingPayload {
    pub category_id: i64,
    pub marketplace_category_id: Option<String>,
}

/// One publish run, applied atomically: category mappings first, then each
/// item's remote ids / published hash / state.
pub fn record_publish(
    conn: &mut Connection,
    outcomes: &[PublishOutcomePayload],
    mappings: &[CategoryMappingPayload],
) -> RepoResult<()> {
    for outcome in outcomes {
        if !PUBLISH_STATES.contains(&outcome.state.as_str()) {
            return Err(format!("bad publish state \"{}\"", outcome.state));
        }
        if outcome.updated_at.is_empty() {
            return Err("updated_at is required".to_string());
        }
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    for mapping in mappings {
        // A marketplace category id is a uuid; refuse to store anything else.
        if let Some(id) = &mapping.marketplace_category_id {
            if id.len() != 36 || !id.contains('-') {
                return Err(format!("bad marketplace category id \"{id}\""));
            }
        }
        let changed = tx
            .execute(
                "UPDATE categories SET marketplace_category_id = ?2 WHERE id = ?1",
                rusqlite::params![mapping.category_id, mapping.marketplace_category_id],
            )
            .map_err(err)?;
        if changed == 0 {
            return Err(format!("no category with id {}", mapping.category_id));
        }
    }
    for outcome in outcomes {
        let changed = tx
            .execute(
                "UPDATE items SET publish_state = ?2, remote_product_id = ?3,
                        remote_variant_id = ?4, content_hash = ?5, updated_at = ?6
                 WHERE id = ?1",
                rusqlite::params![
                    outcome.item_id,
                    outcome.state,
                    outcome.remote_product_id,
                    outcome.remote_variant_id,
                    outcome.content_hash,
                    outcome.updated_at,
                ],
            )
            .map_err(err)?;
        if changed == 0 {
            return Err(format!("no item with id {}", outcome.item_id));
        }
    }
    tx.commit().map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Held bills (B1 gap: hold/resume survives a restart).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldLinePayload {
    pub item_id: i64,
    pub qty_milli: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldBillPayload {
    pub id: Option<i64>,
    pub label: String,
    pub customer_id: Option<i64>,
    pub lines: Vec<HeldLinePayload>,
    pub created_at: String,
}

/// Park or overwrite a held bill; returns its id.
pub fn save_held_bill(conn: &Connection, bill: &HeldBillPayload) -> RepoResult<i64> {
    if bill.lines.is_empty() {
        return Err("a held bill needs at least one line".to_string());
    }
    if bill.lines.iter().any(|l| l.qty_milli <= 0) {
        return Err("held line quantities must be positive".to_string());
    }
    let json = serde_json::to_string(&bill.lines).map_err(err)?;
    match bill.id {
        Some(id) => {
            let n = conn
                .execute(
                    "UPDATE held_bills SET label = ?2, customer_id = ?3, lines_json = ?4 WHERE id = ?1",
                    rusqlite::params![id, bill.label, bill.customer_id, json],
                )
                .map_err(err)?;
            if n == 0 {
                return Err(format!("no held bill with id {id}"));
            }
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO held_bills (label, customer_id, lines_json, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![bill.label, bill.customer_id, json, bill.created_at],
            )
            .map_err(err)?;
            Ok(conn.last_insert_rowid())
        }
    }
}

pub fn take_held_bill(conn: &Connection, id: i64) -> RepoResult<()> {
    let n = conn
        .execute("DELETE FROM held_bills WHERE id = ?1", rusqlite::params![id])
        .map_err(err)?;
    if n == 0 {
        return Err(format!("no held bill with id {id}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Bills.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillLinePayload {
    pub item_id: i64,
    pub name_snapshot: String,
    pub qty_milli: i64,
    pub unit_price_paise: i64,
    pub tax_rate_bp: i64,
    pub tax_paise: i64,
    pub total_paise: i64,
    #[serde(default)]
    pub discount_paise: i64,
    #[serde(default)]
    pub hsn_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentPayload {
    pub mode: String,
    pub amount_paise: i64,
}

/// Fully computed by `@mytowncart-billing/core` in TS; Rust only persists it
/// and allocates the invoice number atomically.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBillPayload {
    pub fy: String,
    pub prefix: String,
    pub customer_id: Option<i64>,
    pub subtotal_paise: i64,
    pub tax_paise: i64,
    pub total_paise: i64,
    #[serde(default)]
    pub discount_paise: i64,
    #[serde(default)]
    pub round_off_paise: i64,
    #[serde(default)]
    pub notes: String,
    pub created_at: String,
    pub lines: Vec<BillLinePayload>,
    pub payments: Vec<PaymentPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportBillLine {
    pub item_id: Option<i64>,
    pub name_snapshot: String,
    pub qty_milli: i64,
    pub total_paise: i64,
    pub tax_paise: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportBillPayment {
    pub mode: String,
    pub amount_paise: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportBillData {
    pub id: i64,
    pub number: String,
    pub status: String,
    pub created_at: String,
    pub subtotal_paise: i64,
    pub tax_paise: i64,
    pub total_paise: i64,
    pub lines: Vec<ReportBillLine>,
    pub payments: Vec<ReportBillPayment>,
}

pub fn get_bills_report_data(
    conn: &Connection,
    from: Option<&str>,
    to: Option<&str>,
) -> RepoResult<Vec<ReportBillData>> {
    let mut sql = "SELECT id, number, status, created_at, subtotal_paise, tax_paise, total_paise FROM bills".to_string();
    let mut where_clauses = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(f) = from {
        where_clauses.push(format!("created_at >= ?{}", params.len() + 1));
        params.push(Box::new(f.to_string()));
    }
    if let Some(t) = to {
        where_clauses.push(format!("created_at <= ?{}", params.len() + 1));
        params.push(Box::new(t.to_string()));
    }
    if !where_clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY created_at ASC, id ASC");

    let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let mut bills = Vec::new();
    let mut bill_ids = Vec::new();

    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_refs), |r| {
            let id: i64 = r.get(0)?;
            Ok((
                id,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })
        .map_err(err)?;

    for row in rows {
        let (id, number, status, created_at, subtotal_paise, tax_paise, total_paise) = row.map_err(err)?;
        bill_ids.push(id);
        bills.push(ReportBillData {
            id,
            number,
            status,
            created_at,
            subtotal_paise,
            tax_paise,
            total_paise,
            lines: Vec::new(),
            payments: Vec::new(),
        });
    }

    if bills.is_empty() {
        return Ok(bills);
    }

    let id_list = bill_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");
    let lines_query = format!(
        "SELECT bill_id, item_id, name_snapshot, qty_milli, total_paise, tax_paise
         FROM bill_lines
         WHERE bill_id IN ({})
         ORDER BY bill_id, line_no",
        id_list
    );
    let mut lines_stmt = conn.prepare(&lines_query).map_err(err)?;
    let mut lines_map: std::collections::HashMap<i64, Vec<ReportBillLine>> = std::collections::HashMap::new();
    let line_rows = lines_stmt
        .query_map([], |r| {
            let bill_id: i64 = r.get(0)?;
            let item_id: Option<i64> = r.get(1)?;
            let name_snapshot: String = r.get(2)?;
            let qty_milli: i64 = r.get(3)?;
            let total_paise: i64 = r.get(4)?;
            let tax_paise: i64 = r.get(5)?;
            Ok((bill_id, ReportBillLine { item_id, name_snapshot, qty_milli, total_paise, tax_paise }))
        })
        .map_err(err)?;
    for r in line_rows {
        let (bill_id, line) = r.map_err(err)?;
        lines_map.entry(bill_id).or_default().push(line);
    }

    let payments_query = format!(
        "SELECT bill_id, mode, amount_paise
         FROM payments
         WHERE bill_id IN ({})
         ORDER BY bill_id, id",
        id_list
    );
    let mut payments_stmt = conn.prepare(&payments_query).map_err(err)?;
    let mut payments_map: std::collections::HashMap<i64, Vec<ReportBillPayment>> = std::collections::HashMap::new();
    let payment_rows = payments_stmt
        .query_map([], |r| {
            let bill_id: i64 = r.get(0)?;
            let mode: String = r.get(1)?;
            let amount_paise: i64 = r.get(2)?;
            Ok((bill_id, ReportBillPayment { mode, amount_paise }))
        })
        .map_err(err)?;
    for r in payment_rows {
        let (bill_id, payment) = r.map_err(err)?;
        payments_map.entry(bill_id).or_default().push(payment);
    }

    for b in &mut bills {
        if let Some(lines) = lines_map.remove(&b.id) {
            b.lines = lines;
        }
        if let Some(payments) = payments_map.remove(&b.id) {
            b.payments = payments;
        }
    }

    Ok(bills)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedBill {
    pub bill_id: i64,
    pub number: String,
    pub seq: i64,
}

/// Invoice number format — MUST stay byte-identical to
/// `packages/core/src/invoice.ts::formatInvoiceNumber`:
/// `prefix + String(seq).padStart(4, "0")` (seqs beyond 9999 are not truncated).
pub fn format_invoice_number(prefix: &str, seq: i64) -> String {
    let digits = seq.to_string();
    let padded = if digits.len() < 4 {
        format!("{:0>4}", digits)
    } else {
        digits
    };
    format!("{prefix}{padded}")
}

pub fn create_bill(conn: &mut Connection, p: &NewBillPayload) -> RepoResult<CreatedBill> {
    if p.lines.is_empty() {
        return Err("a bill needs at least one line".to_string());
    }
    if p.payments.is_empty() {
        return Err("a bill needs at least one payment".to_string());
    }
    for pay in &p.payments {
        if !matches!(pay.mode.as_str(), "cash" | "upi" | "card" | "credit") {
            return Err(format!("bad payment mode \"{}\"", pay.mode));
        }
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;

    // 1. Allocate the invoice number from the (fy, prefix) counter.
    tx.execute(
        "INSERT INTO invoice_counters (fy, prefix, next_no) VALUES (?1, ?2, 1)
         ON CONFLICT (fy, prefix) DO NOTHING",
        rusqlite::params![p.fy, p.prefix],
    )
    .map_err(err)?;
    let seq: i64 = tx
        .query_row(
            "SELECT next_no FROM invoice_counters WHERE fy = ?1 AND prefix = ?2",
            rusqlite::params![p.fy, p.prefix],
            |r| r.get(0),
        )
        .map_err(err)?;
    tx.execute(
        "UPDATE invoice_counters SET next_no = next_no + 1 WHERE fy = ?1 AND prefix = ?2",
        rusqlite::params![p.fy, p.prefix],
    )
    .map_err(err)?;
    let number = format_invoice_number(&p.prefix, seq);

    // 2. Insert the bill.
    tx.execute(
        "INSERT INTO bills (number, fy, status, customer_id, subtotal_paise, tax_paise, total_paise, created_at)
         VALUES (?1, ?2, 'active', ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![number, p.fy, p.customer_id, p.subtotal_paise, p.tax_paise, p.total_paise, p.created_at],
    )
    .map_err(err)?;
    let bill_id = tx.last_insert_rowid();
    let bill_ref = bill_id.to_string();

    // 3. Lines + their sale stock movements + cached sums.
    for (i, line) in p.lines.iter().enumerate() {
        tx.execute(
            "INSERT INTO bill_lines
               (bill_id, line_no, item_id, name_snapshot, qty_milli, unit_price_paise, tax_rate_bp, tax_paise, total_paise)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                bill_id,
                (i + 1) as i64,
                line.item_id,
                line.name_snapshot,
                line.qty_milli,
                line.unit_price_paise,
                line.tax_rate_bp,
                line.tax_paise,
                line.total_paise,
            ],
        )
        .map_err(err)?;
        let movement_id = insert_movement(
            &tx,
            line.item_id,
            -line.qty_milli,
            "sale",
            Some("bill"),
            Some(&bill_ref),
            &p.created_at,
        )?;
        enqueue_movement(&tx, line.item_id, movement_id, -line.qty_milli, "sale", Some(&bill_ref))?;
    }

    // 4. Payments.
    for pay in &p.payments {
        tx.execute(
            "INSERT INTO payments (bill_id, mode, amount_paise) VALUES (?1, ?2, ?3)",
            rusqlite::params![bill_id, pay.mode, pay.amount_paise],
        )
        .map_err(err)?;
    }

    tx.commit().map_err(err)?;
    Ok(CreatedBill { bill_id, number, seq })
}

/// Void a bill: mark it void with a reason and write compensating stock
/// movements (the exact inverse of the sale) — all in ONE transaction.
/// Bills are immutable otherwise; voiding twice is an error.
pub fn void_bill(conn: &mut Connection, bill_id: i64, reason: &str, voided_at: &str) -> RepoResult<()> {
    if reason.trim().is_empty() {
        return Err("a void reason is required".to_string());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let status: String = tx
        .query_row("SELECT status FROM bills WHERE id = ?1", rusqlite::params![bill_id], |r| r.get(0))
        .map_err(|_| format!("no bill with id {bill_id}"))?;
    if status != "active" {
        return Err(format!("bill {bill_id} is already void"));
    }
    tx.execute(
        "UPDATE bills SET status = 'void', voided_at = ?2, void_reason = ?3 WHERE id = ?1",
        rusqlite::params![bill_id, voided_at, reason],
    )
    .map_err(err)?;
    let bill_ref = bill_id.to_string();
    let mut stmt = tx
        .prepare("SELECT item_id, qty_milli FROM bill_lines WHERE bill_id = ?1 AND item_id IS NOT NULL")
        .map_err(err)?;
    let lines: Vec<(i64, i64)> = stmt
        .query_map(rusqlite::params![bill_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    drop(stmt);
    for (item_id, qty_milli) in lines {
        let movement_id =
            insert_movement(&tx, item_id, qty_milli, "void", Some("bill"), Some(&bill_ref), voided_at)?;
        enqueue_movement(&tx, item_id, movement_id, qty_milli, "void", Some(&bill_ref))?;
    }
    tx.commit().map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Credit Notes (Phase 2 Daily-Driver)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditNoteLinePayload {
    pub item_id: Option<i64>,
    pub name_snapshot: String,
    pub qty_milli: i64,
    pub unit_price_paise: i64,
    pub tax_rate_bp: i64,
    pub tax_paise: i64,
    pub total_paise: i64,
    #[serde(default)]
    pub hsn_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCreditNotePayload {
    pub bill_id: i64,
    pub reason: String,
    pub created_at: String,
    pub lines: Vec<CreditNoteLinePayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedCreditNote {
    pub credit_note_id: i64,
    pub number: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditNoteLineRow {
    pub id: i64,
    pub credit_note_id: i64,
    pub item_id: Option<i64>,
    pub name_snapshot: String,
    pub qty_milli: i64,
    pub unit_price_paise: i64,
    pub tax_rate_bp: i64,
    pub tax_paise: i64,
    pub total_paise: i64,
    pub hsn_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditNoteRow {
    pub id: i64,
    pub bill_id: i64,
    pub number: String,
    pub fy: String,
    pub reason: String,
    pub subtotal_paise: i64,
    pub tax_paise: i64,
    pub total_paise: i64,
    pub created_at: String,
    pub lines: Vec<CreditNoteLineRow>,
}

pub fn create_credit_note(conn: &mut Connection, p: &NewCreditNotePayload) -> RepoResult<CreatedCreditNote> {
    if p.lines.is_empty() {
        return Err("a credit note needs at least one line".to_string());
    }
    if p.reason.trim().is_empty() {
        return Err("credit note reason is required".to_string());
    }

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;

    // Get the bill's FY
    let fy: String = tx
        .query_row("SELECT fy FROM bills WHERE id = ?1", rusqlite::params![p.bill_id], |r| r.get(0))
        .map_err(|_| format!("no bill with id {}", p.bill_id))?;

    // Allocate sequential credit note number for this FY
    let prefix = "CN-";
    tx.execute(
        "INSERT INTO invoice_counters (fy, prefix, next_no) VALUES (?1, ?2, 1)
         ON CONFLICT (fy, prefix) DO NOTHING",
        rusqlite::params![fy, prefix],
    )
    .map_err(err)?;
    let seq: i64 = tx
        .query_row(
            "SELECT next_no FROM invoice_counters WHERE fy = ?1 AND prefix = ?2",
            rusqlite::params![fy, prefix],
            |r| r.get(0),
        )
        .map_err(err)?;
    tx.execute(
        "UPDATE invoice_counters SET next_no = next_no + 1 WHERE fy = ?1 AND prefix = ?2",
        rusqlite::params![fy, prefix],
    )
    .map_err(err)?;
    let number = format!("CN-{}-{:04}", fy, seq);

    let mut subtotal_paise: i64 = 0;
    let mut tax_paise: i64 = 0;
    let mut total_paise: i64 = 0;
    for line in &p.lines {
        subtotal_paise += line.total_paise - line.tax_paise;
        tax_paise += line.tax_paise;
        total_paise += line.total_paise;
    }

    tx.execute(
        "INSERT INTO credit_notes (bill_id, number, fy, reason, subtotal_paise, tax_paise, total_paise, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            p.bill_id,
            number,
            fy,
            p.reason.trim(),
            subtotal_paise,
            tax_paise,
            total_paise,
            p.created_at,
        ],
    )
    .map_err(err)?;
    let credit_note_id = tx.last_insert_rowid();
    let cn_ref = credit_note_id.to_string();

    for line in &p.lines {
        tx.execute(
            "INSERT INTO credit_note_lines (credit_note_id, item_id, name_snapshot, qty_milli, unit_price_paise, tax_rate_bp, tax_paise, total_paise, hsn_code)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                credit_note_id,
                line.item_id,
                line.name_snapshot,
                line.qty_milli,
                line.unit_price_paise,
                line.tax_rate_bp,
                line.tax_paise,
                line.total_paise,
                line.hsn_code,
            ],
        )
        .map_err(err)?;

        if let Some(item_id) = line.item_id {
            let movement_id = insert_movement(&tx, item_id, line.qty_milli, "return", Some("credit_note"), Some(&cn_ref), &p.created_at)?;
            enqueue_movement(&tx, item_id, movement_id, line.qty_milli, "return", Some(&cn_ref))?;
        }
    }

    tx.commit().map_err(err)?;
    Ok(CreatedCreditNote {
        credit_note_id,
        number,
    })
}

pub fn list_credit_notes(conn: &Connection, bill_id: Option<i64>) -> RepoResult<Vec<CreditNoteRow>> {
    let sql = match bill_id {
        Some(_) => "SELECT id, bill_id, number, fy, reason, subtotal_paise, tax_paise, total_paise, created_at FROM credit_notes WHERE bill_id = ?1 ORDER BY id DESC",
        None => "SELECT id, bill_id, number, fy, reason, subtotal_paise, tax_paise, total_paise, created_at FROM credit_notes ORDER BY id DESC",
    };
    let mut stmt = conn.prepare(sql).map_err(err)?;
    let mut rows = if let Some(bid) = bill_id {
        stmt.query(rusqlite::params![bid]).map_err(err)?
    } else {
        stmt.query([]).map_err(err)?
    };

    let mut notes = Vec::new();
    while let Some(r) = rows.next().map_err(err)? {
        let id: i64 = r.get(0).map_err(err)?;
        let b_id: i64 = r.get(1).map_err(err)?;
        let number: String = r.get(2).map_err(err)?;
        let fy: String = r.get(3).map_err(err)?;
        let reason: String = r.get(4).map_err(err)?;
        let subtotal: i64 = r.get(5).map_err(err)?;
        let tax: i64 = r.get(6).map_err(err)?;
        let total: i64 = r.get(7).map_err(err)?;
        let created_at: String = r.get(8).map_err(err)?;
        let mut l_stmt = conn.prepare(
            "SELECT id, credit_note_id, item_id, name_snapshot, qty_milli, unit_price_paise, tax_rate_bp, tax_paise, total_paise, hsn_code
             FROM credit_note_lines WHERE credit_note_id = ?1 ORDER BY id ASC"
        ).map_err(err)?;
        let lines = l_stmt.query_map(rusqlite::params![id], |r| {
            Ok(CreditNoteLineRow {
                id: r.get(0)?,
                credit_note_id: r.get(1)?,
                item_id: r.get(2)?,
                name_snapshot: r.get(3)?,
                qty_milli: r.get(4)?,
                unit_price_paise: r.get(5)?,
                tax_rate_bp: r.get(6)?,
                tax_paise: r.get(7)?,
                total_paise: r.get(8)?,
                hsn_code: r.get(9)?,
            })
        }).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;

        notes.push(CreditNoteRow {
            id,
            bill_id: b_id,
            number,
            fy,
            reason,
            subtotal_paise: subtotal,
            tax_paise: tax,
            total_paise: total,
            created_at,
            lines,
        });
    }
    Ok(notes)
}

pub fn get_credit_note(conn: &Connection, id: i64) -> RepoResult<Option<CreditNoteRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, bill_id, number, fy, reason, subtotal_paise, tax_paise, total_paise, created_at
         FROM credit_notes WHERE id = ?1"
    ).map_err(err)?;

    let mut rows = stmt.query_map(rusqlite::params![id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, String>(8)?,
        ))
    }).map_err(err)?;

    let base = match rows.next() {
        Some(r) => r.map_err(err)?,
        None => return Ok(None),
    };

    let mut l_stmt = conn.prepare(
        "SELECT id, credit_note_id, item_id, name_snapshot, qty_milli, unit_price_paise, tax_rate_bp, tax_paise, total_paise, hsn_code
         FROM credit_note_lines WHERE credit_note_id = ?1 ORDER BY id ASC"
    ).map_err(err)?;
    let lines = l_stmt.query_map(rusqlite::params![id], |r| {
        Ok(CreditNoteLineRow {
            id: r.get(0)?,
            credit_note_id: r.get(1)?,
            item_id: r.get(2)?,
            name_snapshot: r.get(3)?,
            qty_milli: r.get(4)?,
            unit_price_paise: r.get(5)?,
            tax_rate_bp: r.get(6)?,
            tax_paise: r.get(7)?,
            total_paise: r.get(8)?,
            hsn_code: r.get(9)?,
        })
    }).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;

    Ok(Some(CreditNoteRow {
        id: base.0,
        bill_id: base.1,
        number: base.2,
        fy: base.3,
        reason: base.4,
        subtotal_paise: base.5,
        tax_paise: base.6,
        total_paise: base.7,
        created_at: base.8,
        lines,
    }))
}

// ---------------------------------------------------------------------------
// Suppliers & Purchases
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierPayload {
    pub id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub gstin: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierRow {
    pub id: i64,
    pub name: String,
    pub phone: String,
    pub gstin: String,
    pub address: String,
    pub created_at: String,
}

pub fn upsert_supplier(conn: &Connection, p: &SupplierPayload) -> RepoResult<i64> {
    if p.name.trim().is_empty() {
        return Err("supplier name is required".to_string());
    }
    match p.id {
        Some(id) => {
            conn.execute(
                "UPDATE suppliers SET name = ?2, phone = ?3, gstin = ?4, address = ?5 WHERE id = ?1",
                rusqlite::params![id, p.name.trim(), p.phone.trim(), p.gstin.trim(), p.address.trim()],
            )
            .map_err(err)?;
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO suppliers (name, phone, gstin, address, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![p.name.trim(), p.phone.trim(), p.gstin.trim(), p.address.trim(), p.created_at],
            )
            .map_err(err)?;
            Ok(conn.last_insert_rowid())
        }
    }
}

pub fn list_suppliers(conn: &Connection, search: Option<String>) -> RepoResult<Vec<SupplierRow>> {
    let mut sql = "SELECT id, name, phone, gstin, address, created_at FROM suppliers".to_string();
    if let Some(ref s) = search {
        if !s.trim().is_empty() {
            sql.push_str(" WHERE name LIKE ?1 OR phone LIKE ?1 OR gstin LIKE ?1");
        }
    }
    sql.push_str(" ORDER BY name COLLATE NOCASE ASC");
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let term = search.map(|s| format!("%{}%", s.trim()));
    let mut rows = if let Some(ref t) = term {
        stmt.query(rusqlite::params![t]).map_err(err)?
    } else {
        stmt.query([]).map_err(err)?
    };
    let mut suppliers = Vec::new();
    while let Some(r) = rows.next().map_err(err)? {
        suppliers.push(SupplierRow {
            id: r.get(0).map_err(err)?,
            name: r.get(1).map_err(err)?,
            phone: r.get(2).map_err(err)?,
            gstin: r.get(3).map_err(err)?,
            address: r.get(4).map_err(err)?,
            created_at: r.get(5).map_err(err)?,
        });
    }
    Ok(suppliers)
}

pub fn delete_supplier(conn: &Connection, supplier_id: i64) -> RepoResult<bool> {
    let purchases_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM purchases WHERE supplier_id = ?1",
            rusqlite::params![supplier_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if purchases_count > 0 {
        return Err("cannot delete supplier with recorded purchases".to_string());
    }
    let changed = conn
        .execute("DELETE FROM suppliers WHERE id = ?1", rusqlite::params![supplier_id])
        .map_err(err)?;
    Ok(changed > 0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseLinePayload {
    pub item_id: Option<i64>,
    pub name_snapshot: String,
    pub qty_milli: i64,
    pub unit_cost_paise: i64,
    pub tax_rate_bp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPurchasePayload {
    pub supplier_id: i64,
    pub invoice_no: String,
    pub invoice_date: String,
    #[serde(default)]
    pub status: Option<String>,
    pub created_at: String,
    pub lines: Vec<PurchaseLinePayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseLineRow {
    pub id: i64,
    pub purchase_id: i64,
    pub item_id: Option<i64>,
    pub name_snapshot: String,
    pub qty_milli: i64,
    pub unit_cost_paise: i64,
    pub tax_rate_bp: i64,
    pub tax_paise: i64,
    pub total_paise: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseRow {
    pub id: i64,
    pub supplier_id: i64,
    pub supplier_name: Option<String>,
    pub invoice_no: String,
    pub invoice_date: String,
    pub subtotal_paise: i64,
    pub tax_paise: i64,
    pub total_paise: i64,
    pub status: String,
    pub created_at: String,
    pub lines: Vec<PurchaseLineRow>,
}

pub fn create_purchase(conn: &mut Connection, p: &NewPurchasePayload) -> RepoResult<i64> {
    if p.lines.is_empty() {
        return Err("a purchase invoice needs at least one line".to_string());
    }
    if p.invoice_no.trim().is_empty() {
        return Err("purchase invoice number is required".to_string());
    }

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;

    // Verify supplier exists
    let s_exists: i64 = tx
        .query_row("SELECT COUNT(*) FROM suppliers WHERE id = ?1", rusqlite::params![p.supplier_id], |r| r.get(0))
        .map_err(err)?;
    if s_exists == 0 {
        return Err(format!("no supplier with id {}", p.supplier_id));
    }

    let mut subtotal: i64 = 0;
    let mut tax: i64 = 0;
    let mut total: i64 = 0;

    struct ComputedPLine {
        item_id: Option<i64>,
        name_snapshot: String,
        qty_milli: i64,
        unit_cost_paise: i64,
        tax_rate_bp: i64,
        tax_paise: i64,
        total_paise: i64,
    }

    let mut computed_lines = Vec::new();
    for l in &p.lines {
        if l.qty_milli <= 0 {
            return Err("quantity must be positive".to_string());
        }
        let line_subtotal = (l.qty_milli * l.unit_cost_paise) / 1000;
        let line_tax = (line_subtotal * l.tax_rate_bp + 5000) / 10000;
        let line_total = line_subtotal + line_tax;

        subtotal += line_subtotal;
        tax += line_tax;
        total += line_total;

        computed_lines.push(ComputedPLine {
            item_id: l.item_id,
            name_snapshot: l.name_snapshot.clone(),
            qty_milli: l.qty_milli,
            unit_cost_paise: l.unit_cost_paise,
            tax_rate_bp: l.tax_rate_bp,
            tax_paise: line_tax,
            total_paise: line_total,
        });
    }

    let status = p.status.as_deref().unwrap_or("received");
    tx.execute(
        "INSERT INTO purchases (supplier_id, invoice_no, invoice_date, subtotal_paise, tax_paise, total_paise, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            p.supplier_id,
            p.invoice_no.trim(),
            p.invoice_date.trim(),
            subtotal,
            tax,
            total,
            status,
            p.created_at,
        ],
    )
    .map_err(err)?;
    let purchase_id = tx.last_insert_rowid();
    let purchase_ref = purchase_id.to_string();

    for l in computed_lines {
        tx.execute(
            "INSERT INTO purchase_lines (purchase_id, item_id, name_snapshot, qty_milli, unit_cost_paise, tax_rate_bp, tax_paise, total_paise)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                purchase_id,
                l.item_id,
                l.name_snapshot,
                l.qty_milli,
                l.unit_cost_paise,
                l.tax_rate_bp,
                l.tax_paise,
                l.total_paise,
            ],
        )
        .map_err(err)?;

        if let Some(item_id) = l.item_id {
            let movement_id = insert_movement(&tx, item_id, l.qty_milli, "purchase", Some("purchase"), Some(&purchase_ref), &p.created_at)?;
            tx.execute(
                "UPDATE items SET cost_price_paise = ?2 WHERE id = ?1",
                rusqlite::params![item_id, l.unit_cost_paise],
            )
            .map_err(err)?;
            enqueue_movement(&tx, item_id, movement_id, l.qty_milli, "purchase", None)?;
        }
    }

    tx.commit().map_err(err)?;
    Ok(purchase_id)
}

pub fn list_purchases(conn: &Connection, supplier_id: Option<i64>) -> RepoResult<Vec<PurchaseRow>> {
    let sql = match supplier_id {
        Some(_) => "SELECT p.id, p.supplier_id, s.name, p.invoice_no, p.invoice_date, p.subtotal_paise, p.tax_paise, p.total_paise, p.status, p.created_at FROM purchases p JOIN suppliers s ON p.supplier_id = s.id WHERE p.supplier_id = ?1 ORDER BY p.id DESC",
        None => "SELECT p.id, p.supplier_id, s.name, p.invoice_no, p.invoice_date, p.subtotal_paise, p.tax_paise, p.total_paise, p.status, p.created_at FROM purchases p JOIN suppliers s ON p.supplier_id = s.id ORDER BY p.id DESC",
    };
    let mut stmt = conn.prepare(sql).map_err(err)?;
    let mut rows = if let Some(sid) = supplier_id {
        stmt.query(rusqlite::params![sid]).map_err(err)?
    } else {
        stmt.query([]).map_err(err)?
    };

    let mut purchases = Vec::new();
    while let Some(r) = rows.next().map_err(err)? {
        let id: i64 = r.get(0).map_err(err)?;
        let s_id: i64 = r.get(1).map_err(err)?;
        let s_name: String = r.get(2).map_err(err)?;
        let inv_no: String = r.get(3).map_err(err)?;
        let inv_date: String = r.get(4).map_err(err)?;
        let subtotal: i64 = r.get(5).map_err(err)?;
        let tax: i64 = r.get(6).map_err(err)?;
        let total: i64 = r.get(7).map_err(err)?;
        let status: String = r.get(8).map_err(err)?;
        let created_at: String = r.get(9).map_err(err)?;
        let mut l_stmt = conn.prepare(
            "SELECT id, purchase_id, item_id, name_snapshot, qty_milli, unit_cost_paise, tax_rate_bp, tax_paise, total_paise
             FROM purchase_lines WHERE purchase_id = ?1 ORDER BY id ASC"
        ).map_err(err)?;
        let lines = l_stmt.query_map(rusqlite::params![id], |r| {
            Ok(PurchaseLineRow {
                id: r.get(0)?,
                purchase_id: r.get(1)?,
                item_id: r.get(2)?,
                name_snapshot: r.get(3)?,
                qty_milli: r.get(4)?,
                unit_cost_paise: r.get(5)?,
                tax_rate_bp: r.get(6)?,
                tax_paise: r.get(7)?,
                total_paise: r.get(8)?,
            })
        }).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;

        purchases.push(PurchaseRow {
            id,
            supplier_id: s_id,
            supplier_name: Some(s_name),
            invoice_no: inv_no,
            invoice_date: inv_date,
            subtotal_paise: subtotal,
            tax_paise: tax,
            total_paise: total,
            status,
            created_at,
            lines,
        });
    }
    Ok(purchases)
}

pub fn get_purchase(conn: &Connection, id: i64) -> RepoResult<Option<PurchaseRow>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.supplier_id, s.name, p.invoice_no, p.invoice_date, p.subtotal_paise, p.tax_paise, p.total_paise, p.status, p.created_at
         FROM purchases p JOIN suppliers s ON p.supplier_id = s.id WHERE p.id = ?1"
    ).map_err(err)?;

    let mut rows = stmt.query_map(rusqlite::params![id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, String>(9)?,
        ))
    }).map_err(err)?;

    let base = match rows.next() {
        Some(r) => r.map_err(err)?,
        None => return Ok(None),
    };

    let mut l_stmt = conn.prepare(
        "SELECT id, purchase_id, item_id, name_snapshot, qty_milli, unit_cost_paise, tax_rate_bp, tax_paise, total_paise
         FROM purchase_lines WHERE purchase_id = ?1 ORDER BY id ASC"
    ).map_err(err)?;
    let lines = l_stmt.query_map(rusqlite::params![id], |r| {
        Ok(PurchaseLineRow {
            id: r.get(0)?,
            purchase_id: r.get(1)?,
            item_id: r.get(2)?,
            name_snapshot: r.get(3)?,
            qty_milli: r.get(4)?,
            unit_cost_paise: r.get(5)?,
            tax_rate_bp: r.get(6)?,
            tax_paise: r.get(7)?,
            total_paise: r.get(8)?,
        })
    }).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;

    Ok(Some(PurchaseRow {
        id: base.0,
        supplier_id: base.1,
        supplier_name: Some(base.2),
        invoice_no: base.3,
        invoice_date: base.4,
        subtotal_paise: base.5,
        tax_paise: base.6,
        total_paise: base.7,
        status: base.8,
        created_at: base.9,
        lines,
    }))
}

// ---------------------------------------------------------------------------
// Users & Roles, Audit Logs, and Stock Audit
// ---------------------------------------------------------------------------

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPayload {
    pub id: Option<i64>,
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub pin: String,
    #[serde(default = "default_true")]
    pub is_active: bool,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRow {
    pub id: i64,
    pub name: String,
    pub role: String,
    pub pin: String,
    pub is_active: bool,
    pub created_at: String,
}

pub fn upsert_user(conn: &Connection, p: &UserPayload) -> RepoResult<i64> {
    if p.name.trim().is_empty() {
        return Err("user name is required".to_string());
    }
    if !matches!(p.role.as_str(), "owner" | "cashier") {
        return Err("role must be 'owner' or 'cashier'".to_string());
    }
    match p.id {
        Some(id) => {
            conn.execute(
                "UPDATE users SET name = ?2, role = ?3, pin = ?4, is_active = ?5 WHERE id = ?1",
                rusqlite::params![id, p.name.trim(), p.role, p.pin.trim(), p.is_active as i64],
            )
            .map_err(err)?;
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO users (name, role, pin, is_active, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![p.name.trim(), p.role, p.pin.trim(), p.is_active as i64, p.created_at],
            )
            .map_err(err)?;
            Ok(conn.last_insert_rowid())
        }
    }
}

pub fn list_users(conn: &Connection) -> RepoResult<Vec<UserRow>> {
    let mut stmt = conn
        .prepare("SELECT id, name, role, pin, is_active, created_at FROM users ORDER BY id ASC")
        .map_err(err)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(UserRow {
                id: r.get(0)?,
                name: r.get(1)?,
                role: r.get(2)?,
                pin: r.get(3)?,
                is_active: r.get::<_, i64>(4)? == 1,
                created_at: r.get(5)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

pub fn verify_pin(conn: &Connection, pin: &str, required_role: Option<&str>) -> RepoResult<Option<UserRow>> {
    let trimmed = pin.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let mut sql = "SELECT id, name, role, pin, is_active, created_at FROM users WHERE pin = ?1 AND is_active = 1".to_string();
    if let Some(role) = required_role {
        sql.push_str(&format!(" AND role = '{role}'"));
    }
    sql.push_str(" LIMIT 1");
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let mut rows = stmt
        .query_map(rusqlite::params![trimmed], |r| {
            Ok(UserRow {
                id: r.get(0)?,
                name: r.get(1)?,
                role: r.get(2)?,
                pin: r.get(3)?,
                is_active: r.get::<_, i64>(4)? == 1,
                created_at: r.get(5)?,
            })
        })
        .map_err(err)?;
    match rows.next() {
        Some(r) => Ok(Some(r.map_err(err)?)),
        None => Ok(None),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogPayload {
    pub user_id: Option<i64>,
    pub action: String,
    #[serde(default)]
    pub details: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogRow {
    pub id: i64,
    pub user_id: Option<i64>,
    pub user_name: Option<String>,
    pub action: String,
    pub details: String,
    pub created_at: String,
}

pub fn record_audit_log(conn: &Connection, p: &AuditLogPayload) -> RepoResult<i64> {
    if p.action.trim().is_empty() {
        return Err("audit action is required".to_string());
    }
    conn.execute(
        "INSERT INTO audit_logs (user_id, action, details, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![p.user_id, p.action.trim(), p.details.trim(), p.created_at],
    )
    .map_err(err)?;
    Ok(conn.last_insert_rowid())
}

pub fn list_audit_logs(conn: &Connection, limit: Option<i64>) -> RepoResult<Vec<AuditLogRow>> {
    let lim = limit.unwrap_or(100);
    let mut stmt = conn.prepare(
        "SELECT a.id, a.user_id, u.name, a.action, a.details, a.created_at
         FROM audit_logs a LEFT JOIN users u ON a.user_id = u.id
         ORDER BY a.id DESC LIMIT ?1"
    ).map_err(err)?;
    let rows = stmt.query_map(rusqlite::params![lim], |r| {
        Ok(AuditLogRow {
            id: r.get(0)?,
            user_id: r.get(1)?,
            user_name: r.get(2)?,
            action: r.get(3)?,
            details: r.get(4)?,
            created_at: r.get(5)?,
        })
    }).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
    Ok(rows)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockDiscrepancyPayload {
    pub item_id: i64,
    pub physical_count_milli: i64,
    #[serde(default)]
    pub reason: Option<String>,
    pub created_at: String,
}

pub fn apply_stock_audit(conn: &mut Connection, discrepancies: &[StockDiscrepancyPayload]) -> RepoResult<i64> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;

    let mut adjusted_count: i64 = 0;
    for disc in discrepancies {
        let current_stock: i64 = tx.query_row(
            "SELECT stock_milli FROM items WHERE id = ?1",
            rusqlite::params![disc.item_id],
            |r| r.get(0),
        ).map_err(|_| format!("no item with id {}", disc.item_id))?;

        let delta = disc.physical_count_milli - current_stock;
        if delta != 0 {
            let movement_id = insert_movement(&tx, disc.item_id, delta, "adjustment", Some("stock_audit"), None, &disc.created_at)?;
            enqueue_movement(&tx, disc.item_id, movement_id, delta, "adjustment", None)?;
            adjusted_count += 1;
        }
    }
    tx.commit().map_err(err)?;
    Ok(adjusted_count)
}

// ---------------------------------------------------------------------------
// Phase 3 Smart-Merchant: Batches & Expiry, Loyalty, Barcodes, Day-End Closures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPayload {
    pub id: Option<i64>,
    pub item_id: i64,
    pub batch_no: String,
    pub mfg_date: Option<String>,
    pub expiry_date: String,
    pub cost_price_paise: i64,
    pub mrp_paise: i64,
    pub stock_milli: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRow {
    pub id: i64,
    pub item_id: i64,
    pub batch_no: String,
    pub mfg_date: Option<String>,
    pub expiry_date: String,
    pub cost_price_paise: i64,
    pub mrp_paise: i64,
    pub stock_milli: i64,
    pub created_at: String,
}

pub fn upsert_batch(conn: &mut Connection, p: &BatchPayload) -> RepoResult<i64> {
    if p.batch_no.trim().is_empty() {
        return Err("batch number is required".to_string());
    }
    if p.expiry_date.trim().is_empty() {
        return Err("expiry date is required".to_string());
    }

    if let Some(id) = p.id {
        conn.execute(
            "UPDATE item_batches SET
                batch_no = ?1, mfg_date = ?2, expiry_date = ?3,
                cost_price_paise = ?4, mrp_paise = ?5, stock_milli = ?6
             WHERE id = ?7",
            rusqlite::params![
                p.batch_no.trim(),
                p.mfg_date,
                p.expiry_date.trim(),
                p.cost_price_paise,
                p.mrp_paise,
                p.stock_milli,
                id,
            ],
        ).map_err(err)?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO item_batches (
                item_id, batch_no, mfg_date, expiry_date,
                cost_price_paise, mrp_paise, stock_milli, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                p.item_id,
                p.batch_no.trim(),
                p.mfg_date,
                p.expiry_date.trim(),
                p.cost_price_paise,
                p.mrp_paise,
                p.stock_milli,
                p.created_at,
            ],
        ).map_err(err)?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn list_batches_for_item(conn: &Connection, item_id: i64) -> RepoResult<Vec<BatchRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, item_id, batch_no, mfg_date, expiry_date,
                cost_price_paise, mrp_paise, stock_milli, created_at
         FROM item_batches
         WHERE item_id = ?1
         ORDER BY expiry_date ASC, id ASC",
    ).map_err(err)?;

    let mut rows = stmt.query(rusqlite::params![item_id]).map_err(err)?;
    let mut list = Vec::new();
    while let Some(r) = rows.next().map_err(err)? {
        list.push(BatchRow {
            id: r.get(0).map_err(err)?,
            item_id: r.get(1).map_err(err)?,
            batch_no: r.get(2).map_err(err)?,
            mfg_date: r.get(3).map_err(err)?,
            expiry_date: r.get(4).map_err(err)?,
            cost_price_paise: r.get(5).map_err(err)?,
            mrp_paise: r.get(6).map_err(err)?,
            stock_milli: r.get(7).map_err(err)?,
            created_at: r.get(8).map_err(err)?,
        });
    }
    Ok(list)
}

pub fn list_expiring_batches(conn: &Connection, days_threshold: i64, now_iso: &str) -> RepoResult<Vec<BatchRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, item_id, batch_no, mfg_date, expiry_date,
                cost_price_paise, mrp_paise, stock_milli, created_at
         FROM item_batches
         WHERE stock_milli > 0
           AND date(expiry_date) <= date(?1, '+' || ?2 || ' days')
         ORDER BY expiry_date ASC",
    ).map_err(err)?;

    let mut rows = stmt.query(rusqlite::params![now_iso, days_threshold]).map_err(err)?;
    let mut list = Vec::new();
    while let Some(r) = rows.next().map_err(err)? {
        list.push(BatchRow {
            id: r.get(0).map_err(err)?,
            item_id: r.get(1).map_err(err)?,
            batch_no: r.get(2).map_err(err)?,
            mfg_date: r.get(3).map_err(err)?,
            expiry_date: r.get(4).map_err(err)?,
            cost_price_paise: r.get(5).map_err(err)?,
            mrp_paise: r.get(6).map_err(err)?,
            stock_milli: r.get(7).map_err(err)?,
            created_at: r.get(8).map_err(err)?,
        });
    }
    Ok(list)
}

// --- Customer Loyalty ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoyaltyTransactionRow {
    pub id: i64,
    pub customer_id: i64,
    pub bill_id: Option<i64>,
    pub points_delta: i64,
    pub reason: String,
    pub created_at: String,
}

pub fn update_customer_loyalty(
    conn: &mut Connection,
    customer_id: i64,
    points_delta: i64,
    bill_id: Option<i64>,
    reason: &str,
    created_at: &str,
) -> RepoResult<i64> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;

    tx.execute(
        "UPDATE customers SET loyalty_points = MAX(0, loyalty_points + ?1) WHERE id = ?2",
        rusqlite::params![points_delta, customer_id],
    ).map_err(err)?;

    tx.execute(
        "INSERT INTO loyalty_transactions (customer_id, bill_id, points_delta, reason, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![customer_id, bill_id, points_delta, reason, created_at],
    ).map_err(err)?;

    let new_balance: i64 = tx.query_row(
        "SELECT loyalty_points FROM customers WHERE id = ?1",
        rusqlite::params![customer_id],
        |r| r.get(0),
    ).map_err(err)?;

    tx.commit().map_err(err)?;
    Ok(new_balance)
}

pub fn get_customer_loyalty_balance(conn: &Connection, customer_id: i64) -> RepoResult<i64> {
    conn.query_row(
        "SELECT loyalty_points FROM customers WHERE id = ?1",
        rusqlite::params![customer_id],
        |r| r.get(0),
    ).map_err(|_| format!("no customer with id {}", customer_id))
}

pub fn list_loyalty_transactions(conn: &Connection, customer_id: i64) -> RepoResult<Vec<LoyaltyTransactionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, customer_id, bill_id, points_delta, reason, created_at
         FROM loyalty_transactions
         WHERE customer_id = ?1
         ORDER BY id DESC",
    ).map_err(err)?;

    let mut rows = stmt.query(rusqlite::params![customer_id]).map_err(err)?;
    let mut list = Vec::new();
    while let Some(r) = rows.next().map_err(err)? {
        list.push(LoyaltyTransactionRow {
            id: r.get(0).map_err(err)?,
            customer_id: r.get(1).map_err(err)?,
            bill_id: r.get(2).map_err(err)?,
            points_delta: r.get(3).map_err(err)?,
            reason: r.get(4).map_err(err)?,
            created_at: r.get(5).map_err(err)?,
        });
    }
    Ok(list)
}

// --- Multiple Barcodes ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemBarcodeRow {
    pub id: i64,
    pub item_id: i64,
    pub barcode: String,
    pub pack_qty_milli: i64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarcodeLookupRow {
    pub item_id: i64,
    pub item_name: String,
    pub barcode: String,
    pub pack_qty_milli: i64,
    pub price_paise: i64,
}

pub fn upsert_item_barcode(
    conn: &Connection,
    item_id: i64,
    barcode: &str,
    pack_qty_milli: i64,
    label: &str,
) -> RepoResult<i64> {
    let trimmed = barcode.trim();
    if trimmed.is_empty() {
        return Err("barcode cannot be empty".to_string());
    }
    conn.execute(
        "INSERT INTO item_barcodes (item_id, barcode, pack_qty_milli, label)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(barcode) DO UPDATE SET
            pack_qty_milli = excluded.pack_qty_milli,
            label = excluded.label",
        rusqlite::params![item_id, trimmed, pack_qty_milli, label.trim()],
    ).map_err(err)?;
    Ok(conn.last_insert_rowid())
}

pub fn list_item_barcodes(conn: &Connection, item_id: i64) -> RepoResult<Vec<ItemBarcodeRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, item_id, barcode, pack_qty_milli, label
         FROM item_barcodes
         WHERE item_id = ?1
         ORDER BY id ASC",
    ).map_err(err)?;

    let mut rows = stmt.query(rusqlite::params![item_id]).map_err(err)?;
    let mut list = Vec::new();
    while let Some(r) = rows.next().map_err(err)? {
        list.push(ItemBarcodeRow {
            id: r.get(0).map_err(err)?,
            item_id: r.get(1).map_err(err)?,
            barcode: r.get(2).map_err(err)?,
            pack_qty_milli: r.get(3).map_err(err)?,
            label: r.get(4).map_err(err)?,
        });
    }
    Ok(list)
}

pub fn delete_item_barcode(conn: &Connection, barcode_id: i64) -> RepoResult<()> {
    conn.execute(
        "DELETE FROM item_barcodes WHERE id = ?1",
        rusqlite::params![barcode_id],
    ).map_err(err)?;
    Ok(())
}

pub fn lookup_item_by_any_barcode(conn: &Connection, barcode: &str) -> RepoResult<Option<BarcodeLookupRow>> {
    let trimmed = barcode.trim();
    // 1. Check secondary barcodes
    let secondary = conn.query_row(
        "SELECT b.item_id, i.name, b.barcode, b.pack_qty_milli, i.price_paise
         FROM item_barcodes b
         JOIN items i ON i.id = b.item_id
         WHERE b.barcode = ?1 AND i.is_active = 1",
        rusqlite::params![trimmed],
        |r| Ok(BarcodeLookupRow {
            item_id: r.get(0)?,
            item_name: r.get(1)?,
            barcode: r.get(2)?,
            pack_qty_milli: r.get(3)?,
            price_paise: r.get(4)?,
        }),
    );
    if let Ok(row) = secondary {
        return Ok(Some(row));
    }

    // 2. Check primary item barcode
    let primary = conn.query_row(
        "SELECT id, name, barcode, 1000 AS pack_qty_milli, price_paise
         FROM items
         WHERE barcode = ?1 AND is_active = 1",
        rusqlite::params![trimmed],
        |r| Ok(BarcodeLookupRow {
            item_id: r.get(0)?,
            item_name: r.get(1)?,
            barcode: r.get(2)?,
            pack_qty_milli: r.get(3)?,
            price_paise: r.get(4)?,
        }),
    );
    if let Ok(row) = primary {
        return Ok(Some(row));
    }

    Ok(None)
}

// --- Day-End Closures & Cash Drawer ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayEndClosurePayload {
    pub closure_date: String,
    pub user_id: Option<i64>,
    pub opening_cash_paise: i64,
    pub cash_sales_paise: i64,
    pub credit_received_paise: i64,
    pub cash_refunds_paise: i64,
    pub expected_cash_paise: i64,
    pub actual_cash_paise: i64,
    pub variance_paise: i64,
    pub total_bills_count: i64,
    pub total_sales_paise: i64,
    pub notes: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayEndClosureRow {
    pub id: i64,
    pub closure_date: String,
    pub user_id: Option<i64>,
    pub user_name: Option<String>,
    pub opening_cash_paise: i64,
    pub cash_sales_paise: i64,
    pub credit_received_paise: i64,
    pub cash_refunds_paise: i64,
    pub expected_cash_paise: i64,
    pub actual_cash_paise: i64,
    pub variance_paise: i64,
    pub total_bills_count: i64,
    pub total_sales_paise: i64,
    pub notes: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayEndExpectedCashRow {
    pub cash_sales_paise: i64,
    pub credit_received_paise: i64,
    pub cash_refunds_paise: i64,
    pub total_bills_count: i64,
    pub total_sales_paise: i64,
}

pub fn create_day_end_closure(conn: &Connection, p: &DayEndClosurePayload) -> RepoResult<i64> {
    conn.execute(
        "INSERT INTO day_end_closures (
            closure_date, user_id, opening_cash_paise, cash_sales_paise,
            credit_received_paise, cash_refunds_paise, expected_cash_paise,
            actual_cash_paise, variance_paise, total_bills_count,
            total_sales_paise, notes, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            p.closure_date.trim(),
            p.user_id,
            p.opening_cash_paise,
            p.cash_sales_paise,
            p.credit_received_paise,
            p.cash_refunds_paise,
            p.expected_cash_paise,
            p.actual_cash_paise,
            p.variance_paise,
            p.total_bills_count,
            p.total_sales_paise,
            p.notes.trim(),
            p.created_at,
        ],
    ).map_err(err)?;
    Ok(conn.last_insert_rowid())
}

pub fn list_day_end_closures(conn: &Connection, from_date: Option<&str>, to_date: Option<&str>) -> RepoResult<Vec<DayEndClosureRow>> {
    let mut sql = "SELECT d.id, d.closure_date, d.user_id, u.name, d.opening_cash_paise,
                          d.cash_sales_paise, d.credit_received_paise, d.cash_refunds_paise,
                          d.expected_cash_paise, d.actual_cash_paise, d.variance_paise,
                          d.total_bills_count, d.total_sales_paise, d.notes, d.created_at
                   FROM day_end_closures d
                   LEFT JOIN users u ON u.id = d.user_id
                   WHERE 1=1".to_string();

    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(f) = from_date {
        sql.push_str(" AND d.closure_date >= ?");
        params.push(Box::new(f.to_string()));
    }
    if let Some(t) = to_date {
        sql.push_str(" AND d.closure_date <= ?");
        params.push(Box::new(t.to_string()));
    }
    sql.push_str(" ORDER BY d.id DESC");

    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rusqlite_params: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let mut rows = stmt.query(rusqlite_params.as_slice()).map_err(err)?;

    let mut list = Vec::new();
    while let Some(r) = rows.next().map_err(err)? {
        list.push(DayEndClosureRow {
            id: r.get(0).map_err(err)?,
            closure_date: r.get(1).map_err(err)?,
            user_id: r.get(2).map_err(err)?,
            user_name: r.get(3).map_err(err)?,
            opening_cash_paise: r.get(4).map_err(err)?,
            cash_sales_paise: r.get(5).map_err(err)?,
            credit_received_paise: r.get(6).map_err(err)?,
            cash_refunds_paise: r.get(7).map_err(err)?,
            expected_cash_paise: r.get(8).map_err(err)?,
            actual_cash_paise: r.get(9).map_err(err)?,
            variance_paise: r.get(10).map_err(err)?,
            total_bills_count: r.get(11).map_err(err)?,
            total_sales_paise: r.get(12).map_err(err)?,
            notes: r.get(13).map_err(err)?,
            created_at: r.get(14).map_err(err)?,
        });
    }
    Ok(list)
}

pub fn get_day_end_expected_cash(conn: &Connection, date_prefix: &str) -> RepoResult<DayEndExpectedCashRow> {
    let trimmed = date_prefix.trim();

    // Cash sales (payments on active bills)
    let cash_sales_paise: i64 = conn.query_row(
        "SELECT COALESCE(SUM(p.amount_paise), 0)
         FROM payments p
         JOIN bills b ON b.id = p.bill_id
         WHERE b.status = 'active'
           AND p.mode = 'cash'
           AND b.created_at LIKE ?1 || '%'",
        rusqlite::params![trimmed],
        |r| r.get(0),
    ).unwrap_or(0);

    // Cash payments received from credit customers
    let credit_received_paise: i64 = conn.query_row(
        "SELECT COALESCE(SUM(amount_paise), 0)
         FROM customer_payments
         WHERE payment_mode = 'cash'
           AND created_at LIKE ?1 || '%'",
        rusqlite::params![trimmed],
        |r| r.get(0),
    ).unwrap_or(0);

    // Cash refunds (returns issued today)
    let cash_refunds_paise: i64 = conn.query_row(
        "SELECT COALESCE(SUM(total_paise), 0)
         FROM credit_notes
         WHERE created_at LIKE ?1 || '%'",
        rusqlite::params![trimmed],
        |r| r.get(0),
    ).unwrap_or(0);

    // Total bills and sales today
    let (total_bills_count, total_sales_paise): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(total_paise), 0)
         FROM bills
         WHERE status = 'active'
           AND created_at LIKE ?1 || '%'",
        rusqlite::params![trimmed],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap_or((0, 0));

    Ok(DayEndExpectedCashRow {
        cash_sales_paise,
        credit_received_paise,
        cash_refunds_paise,
        total_bills_count,
        total_sales_paise,
    })
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(db::DB_FILE_NAME);
        db::migrate(&path).unwrap();
        let conn = db::open(&path).unwrap();
        (dir, conn)
    }

    fn item(conn: &mut Connection, name: &str, opening_stock_milli: i64) -> i64 {
        upsert_item(
            conn,
            &ItemPayload {
                id: None,
                name: name.to_string(),
                barcode: String::new(),
                category_id: None,
                unit_kind: "count".to_string(),
                price_paise: 1000,
                mrp_paise: 1000,
                tax_rate_bp: 0,
                opening_stock_milli,
                is_active: true,
                hsn_code: String::new(),
                cost_price_paise: 0,
                now: "2026-11-04T10:00:00Z".to_string(),
            },
        )
        .unwrap()
    }

    fn bill_payload(item_id: i64, qty_milli: i64) -> NewBillPayload {
        NewBillPayload {
            fy: "2026-27".to_string(),
            prefix: "INV-".to_string(),
            customer_id: None,
            subtotal_paise: 1000,
            tax_paise: 0,
            total_paise: 1000,
            discount_paise: 0,
            round_off_paise: 0,
            notes: String::new(),
            created_at: "2026-11-04T10:00:00Z".to_string(),
            lines: vec![BillLinePayload {
                item_id,
                name_snapshot: "Item".to_string(),
                qty_milli,
                unit_price_paise: 1000,
                tax_rate_bp: 0,
                tax_paise: 0,
                total_paise: 1000,
                discount_paise: 0,
                hsn_code: String::new(),
            }],
            payments: vec![PaymentPayload { mode: "cash".to_string(), amount_paise: 1000 }],
        }
    }

    fn stock_cache(conn: &Connection, item_id: i64) -> i64 {
        conn.query_row("SELECT stock_milli FROM items WHERE id = ?1", [item_id], |r| r.get(0))
            .unwrap()
    }

    fn stock_ledger_sum(conn: &Connection, item_id: i64) -> i64 {
        conn.query_row(
            "SELECT COALESCE(SUM(delta_milli), 0) FROM stock_movements WHERE item_id = ?1",
            [item_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn migration_v2_creates_the_full_schema() {
        let (_dir, conn) = setup();
        for table in [
            "shop_profile", "categories", "items", "customers", "bills", "bill_lines",
            "payments", "stock_movements", "invoice_counters", "outbox", "sync_state", "settings",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "missing table {table}");
        }
    }

    #[test]
    fn invoice_numbers_are_gap_free_and_sequential_within_an_fy() {
        let (_dir, mut conn) = setup();
        let item_id = item(&mut conn, "A", 1_000_000);
        let mut numbers = Vec::new();
        for _ in 0..50 {
            numbers.push(create_bill(&mut conn, &bill_payload(item_id, 1000)).unwrap().number);
        }
        for (i, n) in numbers.iter().enumerate() {
            assert_eq!(*n, format_invoice_number("INV-", (i + 1) as i64));
        }
        // Counter now points past the last allocated number.
        let next: i64 = conn
            .query_row(
                "SELECT next_no FROM invoice_counters WHERE fy = '2026-27' AND prefix = 'INV-'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(next, 51);
    }

    #[test]
    fn invoice_counters_are_scoped_per_fy_and_prefix() {
        let (_dir, mut conn) = setup();
        let item_id = item(&mut conn, "A", 1_000_000);
        let a = create_bill(&mut conn, &bill_payload(item_id, 1000)).unwrap();
        let mut p_next_fy = bill_payload(item_id, 1000);
        p_next_fy.fy = "2027-28".to_string();
        let b = create_bill(&mut conn, &p_next_fy).unwrap();
        let mut p_other_prefix = bill_payload(item_id, 1000);
        p_other_prefix.prefix = "EST-".to_string();
        let c = create_bill(&mut conn, &p_other_prefix).unwrap();
        assert_eq!(a.number, "INV-0001");
        assert_eq!(b.number, "INV-0001"); // new FY restarts the sequence
        assert_eq!(c.number, "EST-0001"); // different prefix has its own sequence
    }

    #[test]
    fn format_invoice_number_matches_the_core_rule() {
        assert_eq!(format_invoice_number("INV-", 1), "INV-0001");
        assert_eq!(format_invoice_number("INV-", 42), "INV-0042");
        assert_eq!(format_invoice_number("INV-", 10_000), "INV-10000");
        assert_eq!(format_invoice_number("MTC/", 7), "MTC/0007");
    }

    #[test]
    fn void_restores_stock_via_compensating_movements() {
        let (_dir, mut conn) = setup();
        let item_id = item(&mut conn, "A", 10_000); // 10 units
        let created = create_bill(&mut conn, &bill_payload(item_id, 2500)).unwrap();
        assert_eq!(stock_cache(&conn, item_id), 7_500);

        void_bill(&mut conn, created.bill_id, "customer changed mind", "2026-11-04T11:00:00Z").unwrap();
        assert_eq!(stock_cache(&conn, item_id), 10_000);
        assert_eq!(stock_cache(&conn, item_id), stock_ledger_sum(&conn, item_id));

        let (status, reason): (String, String) = conn
            .query_row(
                "SELECT status, void_reason FROM bills WHERE id = ?1",
                [created.bill_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "void");
        assert_eq!(reason, "customer changed mind");

        // Voiding twice fails; voiding without a reason fails.
        assert!(void_bill(&mut conn, created.bill_id, "again", "2026-11-04T11:05:00Z").is_err());
        let other = create_bill(&mut conn, &bill_payload(item_id, 1000)).unwrap();
        assert!(void_bill(&mut conn, other.bill_id, "  ", "2026-11-04T11:06:00Z").is_err());
    }

    #[test]
    fn stock_cache_equals_the_sum_of_movements_after_mixed_operations() {
        let (_dir, mut conn) = setup();
        let a = item(&mut conn, "A", 10_000);
        let b = item(&mut conn, "B", 0);
        adjust_stock(&mut conn, b, 5_000, "purchase", "2026-11-04T09:00:00Z").unwrap();
        let bill1 = create_bill(&mut conn, &bill_payload(a, 2_000)).unwrap();
        let mut p2 = bill_payload(a, 500);
        p2.lines.push(BillLinePayload {
            item_id: b,
            name_snapshot: "B".to_string(),
            qty_milli: 1_000,
            unit_price_paise: 1000,
            tax_rate_bp: 0,
            tax_paise: 0,
            total_paise: 1000,
            discount_paise: 0,
            hsn_code: String::new(),
        });
        create_bill(&mut conn, &p2).unwrap();
        adjust_stock(&mut conn, a, -250, "adjustment", "2026-11-04T12:00:00Z").unwrap();
        void_bill(&mut conn, bill1.bill_id, "test void", "2026-11-04T12:30:00Z").unwrap();

        for id in [a, b] {
            assert_eq!(stock_cache(&conn, id), stock_ledger_sum(&conn, id));
        }
        assert_eq!(stock_cache(&conn, a), 10_000 - 500 - 250);
        assert_eq!(stock_cache(&conn, b), 5_000 - 1_000);
    }

    #[test]
    fn concurrent_saves_never_duplicate_or_skip_a_number() {
        let (dir, mut conn) = setup();
        let item_id = item(&mut conn, "A", 10_000_000);
        let path = dir.path().join(db::DB_FILE_NAME);

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let path: PathBuf = path.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                let mut conn = db::open(&path).unwrap();
                barrier.wait();
                let mut numbers = Vec::new();
                for _ in 0..25 {
                    numbers.push(create_bill(&mut conn, &bill_payload(item_id, 1000)).unwrap().number);
                }
                numbers
            }));
        }
        barrier.wait();
        let mut main_numbers = Vec::new();
        for _ in 0..25 {
            main_numbers.push(create_bill(&mut conn, &bill_payload(item_id, 1000)).unwrap().number);
        }
        let mut all = main_numbers;
        for h in handles {
            all.extend(h.join().unwrap());
        }
        all.sort();
        all.dedup();
        assert_eq!(all.len(), 75, "numbers must be unique");
        for (i, n) in all.iter().enumerate() {
            assert_eq!(*n, format_invoice_number("INV-", (i + 1) as i64), "gap-free sequence");
        }
    }

    #[test]
    fn csv_import_isolates_bad_rows() {
        let (_dir, mut conn) = setup();
        let good = ItemPayload {
            id: None,
            name: "Good".to_string(),
            barcode: "111".to_string(),
            category_id: None,
            unit_kind: "count".to_string(),
            price_paise: 100,
            mrp_paise: 100,
            tax_rate_bp: 0,
            opening_stock_milli: 2_000,
            is_active: true,
            hsn_code: String::new(),
            cost_price_paise: 0,
            now: "2026-11-04T10:00:00Z".to_string(),
        };
        let bad = ItemPayload { name: String::new(), ..good.clone() };
        let results = import_items(&mut conn, &[good, bad]).unwrap();
        assert_eq!(results.len(), 2);
        assert!(results[0].ok);
        assert!(!results[1].ok);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "the bad row must not fail the batch");
    }

    #[test]
    fn reimporting_a_barcode_updates_instead_of_duplicating() {
        let (_dir, mut conn) = setup();
        let payload = ItemPayload {
            id: None,
            name: "Original".to_string(),
            barcode: "222".to_string(),
            category_id: None,
            unit_kind: "count".to_string(),
            price_paise: 100,
            mrp_paise: 100,
            tax_rate_bp: 0,
            opening_stock_milli: 1_000,
            is_active: true,
            hsn_code: String::new(),
            cost_price_paise: 0,
            now: "2026-11-04T10:00:00Z".to_string(),
        };
        import_items(&mut conn, std::slice::from_ref(&payload)).unwrap();
        let updated = ItemPayload { name: "Renamed".to_string(), ..payload };
        let results = import_items(&mut conn, &[updated]).unwrap();
        assert!(results[0].ok);
        let (count, name, stock): (i64, String, i64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(name), SUM(stock_milli) FROM items WHERE barcode = '222'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(name, "Renamed");
        assert_eq!(stock, 1_000, "re-import must not re-apply opening stock");
    }

    #[test]
    fn query_rows_maps_values_to_json() {
        let (_dir, mut conn) = setup();
        let item_id = item(&mut conn, "A", 3_000);
        let rows = query_rows(
            &conn,
            "SELECT id, name, stock_milli, category_id FROM items WHERE id = ?1",
            vec![serde_json::json!(item_id)],
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], serde_json::json!("A"));
        assert_eq!(rows[0]["stock_milli"], serde_json::json!(3_000));
        assert!(rows[0]["category_id"].is_null());
    }

    #[test]
    fn record_publish_links_items_and_mappings_atomically() {
        let (_dir, mut conn) = setup();
        let a = item(&mut conn, "A", 1_000);
        let cat = upsert_category(
            &conn,
            &CategoryPayload { id: None, name: "Snacks".to_string() },
        )
        .unwrap();
        let uuid = "11111111-2222-3333-4444-555555555555";
        record_publish(
            &mut conn,
            &[PublishOutcomePayload {
                item_id: a,
                state: "live".to_string(),
                updated_at: "2026-11-05T10:00:00+05:30".to_string(),
                remote_product_id: Some("p1".to_string()),
                remote_variant_id: Some("v1".to_string()),
                content_hash: Some("abcd1234".to_string()),
            }],
            &[CategoryMappingPayload { category_id: cat, marketplace_category_id: Some(uuid.to_string()) }],
        )
        .unwrap();

        let row = &query_rows(
            &conn,
            "SELECT publish_state, remote_product_id, remote_variant_id, content_hash, updated_at
             FROM items WHERE id = ?1",
            vec![serde_json::json!(a)],
        )
        .unwrap()[0];
        assert_eq!(row["publish_state"], serde_json::json!("live"));
        assert_eq!(row["remote_product_id"], serde_json::json!("p1"));
        assert_eq!(row["content_hash"], serde_json::json!("abcd1234"));
        assert_eq!(row["updated_at"], serde_json::json!("2026-11-05T10:00:00+05:30"));
        let mapping = &query_rows(
            &conn,
            "SELECT marketplace_category_id FROM categories WHERE id = ?1",
            vec![serde_json::json!(cat)],
        )
        .unwrap()[0];
        assert_eq!(mapping["marketplace_category_id"], serde_json::json!(uuid));
    }

    #[test]
    fn record_publish_rejects_bad_input_without_writing_anything() {
        let (_dir, mut conn) = setup();
        let a = item(&mut conn, "A", 1_000);

        let bad_state = record_publish(
            &mut conn,
            &[PublishOutcomePayload {
                item_id: a,
                state: "published".to_string(),
                updated_at: "2026-11-05T10:00:00+05:30".to_string(),
                remote_product_id: None,
                remote_variant_id: None,
                content_hash: None,
            }],
            &[],
        );
        assert!(bad_state.is_err());

        let bad_category = record_publish(
            &mut conn,
            &[PublishOutcomePayload {
                item_id: a,
                state: "live".to_string(),
                updated_at: "2026-11-05T10:00:00+05:30".to_string(),
                remote_product_id: None,
                remote_variant_id: None,
                content_hash: None,
            }],
            &[CategoryMappingPayload {
                category_id: 999,
                marketplace_category_id: Some("not-a-uuid".to_string()),
            }],
        );
        assert!(bad_category.is_err());

        let state: String = conn
            .query_row("SELECT publish_state FROM items WHERE id = ?1", [a], |r| r.get(0))
            .unwrap();
        assert_eq!(state, "local_only");
    }

    #[test]
    fn customer_payments_and_delete_validation() {
        let (_dir, conn) = setup();
        let cust_id = upsert_customer(
            &conn,
            &CustomerPayload {
                id: None,
                name: "Ramesh".to_string(),
                phone: "9876543210".to_string(),
                gstin: "33AAAAA0000A1Z5".to_string(),
                address: "Chennai".to_string(),
                now: "2026-11-06T10:00:00Z".to_string(),
            },
        )
        .unwrap();

        let pay_id = record_customer_payment(
            &conn,
            &CustomerPaymentPayload {
                customer_id: cust_id,
                amount_paise: 50_000,
                mode: "upi".to_string(),
                notes: "GPay partial payment".to_string(),
                created_at: "2026-11-06T11:00:00Z".to_string(),
            },
        )
        .unwrap();
        assert!(pay_id > 0);

        let payments = list_customer_payments(&conn, cust_id).unwrap();
        assert_eq!(payments.len(), 1);
        assert_eq!(payments[0].amount_paise, 50_000);
        assert_eq!(payments[0].mode, "upi");

        // Cannot delete customer who has payment records
        let del_err = delete_customer(&conn, cust_id);
        assert!(del_err.is_err());
    }

    #[test]
    fn batch_report_data_fetches_bills_lines_payments() {
        let (_dir, mut conn) = setup();
        let a = item(&mut conn, "Item A", 10_000);
        let bill = create_bill(&mut conn, &bill_payload(a, 1000)).unwrap();

        let report_data = get_bills_report_data(&conn, Some("2026-11-01T00:00:00"), Some("2026-11-10T23:59:59")).unwrap();
        assert_eq!(report_data.len(), 1);
        assert_eq!(report_data[0].id, bill.bill_id);
        assert_eq!(report_data[0].lines.len(), 1);
        assert_eq!(report_data[0].lines[0].total_paise, 1000);
        assert_eq!(report_data[0].payments.len(), 1);
        assert_eq!(report_data[0].payments[0].amount_paise, 1000);
    }

    #[test]
    fn credit_notes_create_and_restore_stock() {
        let (_dir, mut conn) = setup();
        let a = item(&mut conn, "Rice 1kg", 10_000);
        let bill = create_bill(&mut conn, &bill_payload(a, 3_000)).unwrap();
        assert_eq!(stock_cache(&conn, a), 7_000);

        let cn = create_credit_note(
            &mut conn,
            &NewCreditNotePayload {
                bill_id: bill.bill_id,
                reason: "Customer returned damaged bag".to_string(),
                created_at: "2026-11-06T12:00:00Z".to_string(),
                lines: vec![CreditNoteLinePayload {
                    item_id: Some(a),
                    name_snapshot: "Rice 1kg".to_string(),
                    qty_milli: 1_000,
                    unit_price_paise: 1000,
                    tax_rate_bp: 0,
                    tax_paise: 0,
                    total_paise: 1000,
                    hsn_code: String::new(),
                }],
            },
        )
        .unwrap();

        assert!(cn.number.starts_with("CN-2026-27-"));
        assert_eq!(stock_cache(&conn, a), 8_000);

        let notes = list_credit_notes(&conn, Some(bill.bill_id)).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].total_paise, 1000);
        assert_eq!(notes[0].lines.len(), 1);
        assert_eq!(notes[0].lines[0].qty_milli, 1_000);

        let single = get_credit_note(&conn, cn.credit_note_id).unwrap().unwrap();
        assert_eq!(single.number, cn.number);
    }

    #[test]
    fn suppliers_and_purchases_update_stock_and_cost() {
        let (_dir, mut conn) = setup();
        let s_id = upsert_supplier(
            &conn,
            &SupplierPayload {
                id: None,
                name: "Metro Wholesalers".to_string(),
                phone: "9123456780".to_string(),
                gstin: "33AAACM1234F1Z5".to_string(),
                address: "Koyambedu Wholesale Market".to_string(),
                created_at: "2026-11-06T10:00:00Z".to_string(),
            },
        )
        .unwrap();

        let a = item(&mut conn, "Dal 1kg", 5_000);

        let p_id = create_purchase(
            &mut conn,
            &NewPurchasePayload {
                supplier_id: s_id,
                invoice_no: "PO-2026-999".to_string(),
                invoice_date: "2026-11-06".to_string(),
                status: Some("received".to_string()),
                created_at: "2026-11-06T12:00:00Z".to_string(),
                lines: vec![PurchaseLinePayload {
                    item_id: Some(a),
                    name_snapshot: "Dal 1kg".to_string(),
                    qty_milli: 10_000,
                    unit_cost_paise: 800,
                    tax_rate_bp: 500, // 5%
                }],
            },
        )
        .unwrap();
        assert!(p_id > 0);

        // Stock increased by 10_000 (from 5_000 to 15_000)
        assert_eq!(stock_cache(&conn, a), 15_000);

        // Item cost price updated to 800 paise
        let cost: i64 = conn
            .query_row("SELECT cost_price_paise FROM items WHERE id = ?1", [a], |r| r.get(0))
            .unwrap();
        assert_eq!(cost, 800);

        let purchases = list_purchases(&conn, Some(s_id)).unwrap();
        assert_eq!(purchases.len(), 1);
        assert_eq!(purchases[0].invoice_no, "PO-2026-999");
        assert_eq!(purchases[0].lines.len(), 1);

        // Cannot delete supplier with purchases
        assert!(delete_supplier(&conn, s_id).is_err());
    }

    #[test]
    fn users_pin_verification_and_audit_logs() {
        let (_dir, conn) = setup();
        let u1 = upsert_user(
            &conn,
            &UserPayload {
                id: None,
                name: "Store Owner".to_string(),
                role: "owner".to_string(),
                pin: "1234".to_string(),
                is_active: true,
                created_at: "2026-11-06T10:00:00Z".to_string(),
            },
        )
        .unwrap();

        let u2 = upsert_user(
            &conn,
            &UserPayload {
                id: None,
                name: "Cashier Priya".to_string(),
                role: "cashier".to_string(),
                pin: "5678".to_string(),
                is_active: true,
                created_at: "2026-11-06T10:00:00Z".to_string(),
            },
        )
        .unwrap();

        let users = list_users(&conn).unwrap();
        assert_eq!(users.len(), 2);

        // Verification
        let v_owner = verify_pin(&conn, "1234", Some("owner")).unwrap();
        assert!(v_owner.is_some());
        assert_eq!(v_owner.unwrap().id, u1);

        let v_cashier_as_owner = verify_pin(&conn, "5678", Some("owner")).unwrap();
        assert!(v_cashier_as_owner.is_none());

        let v_cashier = verify_pin(&conn, "5678", None).unwrap();
        assert!(v_cashier.is_some());
        assert_eq!(v_cashier.unwrap().id, u2);

        // Audit log
        let log_id = record_audit_log(
            &conn,
            &AuditLogPayload {
                user_id: Some(u1),
                action: "price_override".to_string(),
                details: "Override Rice price to 95.00".to_string(),
                created_at: "2026-11-06T12:00:00Z".to_string(),
            },
        )
        .unwrap();
        assert!(log_id > 0);

        let logs = list_audit_logs(&conn, Some(10)).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].action, "price_override");
        assert_eq!(logs[0].user_name.as_deref(), Some("Store Owner"));
    }

    #[test]
    fn stock_audit_discrepancy_adjustments() {
        let (_dir, mut conn) = setup();
        let a = item(&mut conn, "Apple", 10_000);
        let b = item(&mut conn, "Banana", 5_000);

        // Physical count: Apple has 9_000 (1 missing), Banana has 5_000 (no change)
        let count = apply_stock_audit(
            &mut conn,
            &[
                StockDiscrepancyPayload {
                    item_id: a,
                    physical_count_milli: 9_000,
                    reason: Some("Audit count".to_string()),
                    created_at: "2026-11-06T12:00:00Z".to_string(),
                },
                StockDiscrepancyPayload {
                    item_id: b,
                    physical_count_milli: 5_000,
                    reason: Some("Audit count".to_string()),
                    created_at: "2026-11-06T12:00:00Z".to_string(),
                },
            ],
        )
        .unwrap();

        assert_eq!(count, 1); // Only 1 had discrepancy
        assert_eq!(stock_cache(&conn, a), 9_000);
        assert_eq!(stock_cache(&conn, b), 5_000);
    }

    #[test]
    fn batches_upsert_and_expiry_list() {
        let (_dir, mut conn) = setup();
        let tea = item(&mut conn, "Tea", 10_000);

        let b1 = upsert_batch(&mut conn, &BatchPayload {
            id: None,
            item_id: tea,
            batch_no: "BATCH-001".to_string(),
            mfg_date: Some("2026-01-01".to_string()),
            expiry_date: "2026-11-20".to_string(),
            cost_price_paise: 8000,
            mrp_paise: 12000,
            stock_milli: 5_000,
            created_at: "2026-11-06T12:00:00Z".to_string(),
        }).unwrap();

        let b2 = upsert_batch(&mut conn, &BatchPayload {
            id: None,
            item_id: tea,
            batch_no: "BATCH-002".to_string(),
            mfg_date: Some("2026-02-01".to_string()),
            expiry_date: "2027-05-15".to_string(),
            cost_price_paise: 8500,
            mrp_paise: 12500,
            stock_milli: 5_000,
            created_at: "2026-11-06T12:00:00Z".to_string(),
        }).unwrap();

        assert!(b1 > 0 && b2 > 0);
        let batches = list_batches_for_item(&conn, tea).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].batch_no, "BATCH-001");

        // Expiring in 30 days relative to 2026-11-06
        let expiring = list_expiring_batches(&conn, 30, "2026-11-06").unwrap();
        assert_eq!(expiring.len(), 1);
        assert_eq!(expiring[0].batch_no, "BATCH-001");
    }

    #[test]
    fn customer_loyalty_points_accrual_and_history() {
        let (_dir, mut conn) = setup();
        let cust_id = upsert_customer(&conn, &CustomerPayload {
            id: None,
            name: "Rajesh Kumar".to_string(),
            phone: "9840012345".to_string(),
            gstin: "".to_string(),
            address: "".to_string(),
            now: "2026-11-06T12:00:00Z".to_string(),
        }).unwrap();

        let bal = update_customer_loyalty(&mut conn, cust_id, 25, None, "Bill purchase #1", "2026-11-06T12:00:00Z").unwrap();
        assert_eq!(bal, 25);
        assert_eq!(get_customer_loyalty_balance(&conn, cust_id).unwrap(), 25);

        let bal2 = update_customer_loyalty(&mut conn, cust_id, -10, None, "Redeemed points", "2026-11-06T12:10:00Z").unwrap();
        assert_eq!(bal2, 15);

        let txs = list_loyalty_transactions(&conn, cust_id).unwrap();
        assert_eq!(txs.len(), 2);
    }

    #[test]
    fn multiple_barcodes_lookup() {
        let (_dir, mut conn) = setup();
        let biscuit = item(&mut conn, "Parle-G", 100_000);

        // Add box barcode (10-pack = 10_000 milli)
        let bc_id = upsert_item_barcode(&conn, biscuit, "8901030999999", 10_000, "10-Pack Box").unwrap();
        assert!(bc_id > 0);

        let barcodes = list_item_barcodes(&conn, biscuit).unwrap();
        assert_eq!(barcodes.len(), 1);
        assert_eq!(barcodes[0].label, "10-Pack Box");

        // Lookup by secondary barcode
        let lookup = lookup_item_by_any_barcode(&conn, "8901030999999").unwrap().unwrap();
        assert_eq!(lookup.item_id, biscuit);
        assert_eq!(lookup.pack_qty_milli, 10_000);
    }

    #[test]
    fn day_end_closures_and_expected_cash() {
        let (_dir, conn) = setup();
        let today = "2026-11-06";

        let id = create_day_end_closure(&conn, &DayEndClosurePayload {
            closure_date: today.to_string(),
            user_id: None,
            opening_cash_paise: 200_000,
            cash_sales_paise: 500_000,
            credit_received_paise: 50_000,
            cash_refunds_paise: 10_000,
            expected_cash_paise: 740_000,
            actual_cash_paise: 740_000,
            variance_paise: 0,
            total_bills_count: 15,
            total_sales_paise: 800_000,
            notes: "Perfect closing".to_string(),
            created_at: "2026-11-06T21:00:00Z".to_string(),
        }).unwrap();
        assert!(id > 0);

        let closures = list_day_end_closures(&conn, Some(today), Some(today)).unwrap();
        assert_eq!(closures.len(), 1);
        assert_eq!(closures[0].expected_cash_paise, 740_000);
        assert_eq!(closures[0].variance_paise, 0);

        let expected = get_day_end_expected_cash(&conn, today).unwrap();
        assert_eq!(expected.total_bills_count, 0); // No bills seeded in fresh test db
    }
}
