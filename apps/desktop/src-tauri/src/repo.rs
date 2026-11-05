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
    pub now: String,
}

pub fn upsert_customer(conn: &Connection, c: &CustomerPayload) -> RepoResult<i64> {
    if c.name.trim().is_empty() {
        return Err("customer name is required".to_string());
    }
    match c.id {
        Some(id) => {
            conn.execute(
                "UPDATE customers SET name = ?2, phone = ?3, updated_at = ?4 WHERE id = ?1",
                rusqlite::params![id, c.name, c.phone, c.now],
            )
            .map_err(err)?;
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO customers (name, phone, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                rusqlite::params![c.name, c.phone, c.now],
            )
            .map_err(err)?;
            Ok(conn.last_insert_rowid())
        }
    }
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
                       updated_at = ?10
                     WHERE id = ?1",
                    rusqlite::params![
                        id, p.name, p.barcode, p.category_id, p.unit_kind, p.price_paise,
                        p.mrp_paise, p.tax_rate_bp, p.is_active as i64, p.now,
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
                   tax_rate_bp, stock_milli, is_active, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)",
                rusqlite::params![
                    p.name, p.barcode, p.category_id, p.unit_kind, p.price_paise, p.mrp_paise,
                    p.tax_rate_bp, p.is_active as i64, p.now,
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
    pub created_at: String,
    pub lines: Vec<BillLinePayload>,
    pub payments: Vec<PaymentPayload>,
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
            created_at: "2026-11-04T10:00:00Z".to_string(),
            lines: vec![BillLinePayload {
                item_id,
                name_snapshot: "Item".to_string(),
                qty_milli,
                unit_price_paise: 1000,
                tax_rate_bp: 0,
                tax_paise: 0,
                total_paise: 1000,
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
}
