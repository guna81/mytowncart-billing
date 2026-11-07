// SPDX-License-Identifier: Apache-2.0
//! Tauri 2 shell for MyTownCart Billing: owns the SQLite database
//! (forward-only migrations with a pre-migration backup copy) and the OS
//! keychain. The web UI reaches both only through these commands.
//!
//! Reads go through the generic parameterized `query_rows` command; every
//! multi-table write is a dedicated typed command running in ONE
//! transaction (see `repo.rs`).

pub(crate) mod auth;
pub(crate) mod backup;
pub(crate) mod db;
pub(crate) mod keychain;
pub(crate) mod media;
pub(crate) mod reconcile;
pub(crate) mod repo;
pub(crate) mod server;
pub(crate) mod sync;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Manager;

/// Upper bound for anything read from disk into memory (backups, photos).
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    /// Single shared connection. Commands that write take the mutex and run
    /// their whole transaction under it; a busy_timeout covers any reader
    /// connections (e.g. the B0 `db_status` path) racing a writer.
    pub conn: Arc<Mutex<rusqlite::Connection>>,
    /// Set while a restore swaps the database file; every other command
    /// refuses to run so no write lands in the discarded file.
    pub restoring: Arc<AtomicBool>,
    /// PIN login sessions and brute-force throttle (see `auth.rs`).
    pub auth: Arc<auth::Auth>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbStatus {
    db_path: String,
    schema_version: u32,
    latest_version: u32,
    hello_rows: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HelloResult {
    hello_rows: u64,
}

#[tauri::command]
fn db_status(state: tauri::State<'_, AppState>) -> Result<DbStatus, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let schema_version: u32 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let hello_rows: u64 = conn
        .query_row("SELECT COUNT(*) FROM hello_log", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let latest_version = db::MIGRATIONS.last().map(|m| m.version).unwrap_or(0);
    Ok(DbStatus {
        db_path: state.db_path.display().to_string(),
        schema_version,
        latest_version,
        hello_rows,
    })
}

#[tauri::command]
fn db_hello(state: tauri::State<'_, AppState>) -> Result<HelloResult, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO hello_log (written_at) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        [],
    )
    .map_err(|e| e.to_string())?;
    let hello_rows: u64 = conn
        .query_row("SELECT COUNT(*) FROM hello_log", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(HelloResult { hello_rows })
}

#[tauri::command]
fn keychain_set(key: String, value: String) -> Result<(), String> {
    keychain::set(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_get(key: String) -> Result<Option<String>, String> {
    keychain::get(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_delete(key: String) -> Result<(), String> {
    keychain::delete(&key).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// B1 storage commands (reads generic, writes typed + transactional).
// ---------------------------------------------------------------------------

#[tauri::command]
fn query_rows(
    state: tauri::State<'_, AppState>,
    sql: String,
    params: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::query_rows(&conn, &sql, params)
}

#[tauri::command]
fn save_shop_profile(
    state: tauri::State<'_, AppState>,
    profile: repo::ShopProfilePayload,
    session: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    state.auth.authorize(&conn, "save_shop_profile", session.as_deref())?;
    repo::save_shop_profile(&conn, &profile)
}

#[tauri::command]
fn upsert_category(
    state: tauri::State<'_, AppState>,
    category: repo::CategoryPayload,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::upsert_category(&conn, &category)
}

#[tauri::command]
fn upsert_customer(
    state: tauri::State<'_, AppState>,
    customer: repo::CustomerPayload,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::upsert_customer(&conn, &customer)
}

#[tauri::command]
fn delete_customer(
    state: tauri::State<'_, AppState>,
    customer_id: i64,
    session: Option<String>,
) -> Result<bool, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let actor = state.auth.authorize(&conn, "delete_customer", session.as_deref())?;
    let out = repo::delete_customer(&conn, customer_id)?;
    auth::audit(&conn, actor, "delete_customer", format!("customer {customer_id}"));
    Ok(out)
}

#[tauri::command]
fn record_customer_payment(
    state: tauri::State<'_, AppState>,
    payment: repo::CustomerPaymentPayload,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::record_customer_payment(&conn, &payment)
}

#[tauri::command]
fn list_customer_payments(
    state: tauri::State<'_, AppState>,
    customer_id: i64,
) -> Result<Vec<repo::CustomerPaymentRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::list_customer_payments(&conn, customer_id)
}

#[tauri::command]
fn get_bills_report_data(
    state: tauri::State<'_, AppState>,
    from: Option<String>,
    to: Option<String>,
) -> Result<Vec<repo::ReportBillData>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::get_bills_report_data(&conn, from.as_deref(), to.as_deref())
}

#[tauri::command]
fn upsert_item(state: tauri::State<'_, AppState>, item: repo::ItemPayload,
    session: Option<String>,
) -> Result<i64, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    state.auth.authorize(&conn, "upsert_item", session.as_deref())?;
    repo::upsert_item(&mut conn, &item)
}

#[tauri::command]
fn import_items(
    state: tauri::State<'_, AppState>,
    items: Vec<repo::ItemPayload>,
    session: Option<String>,
) -> Result<Vec<repo::ImportRowResult>, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    state.auth.authorize(&conn, "import_items", session.as_deref())?;
    repo::import_items(&mut conn, &items)
}

#[tauri::command]
fn adjust_stock(
    state: tauri::State<'_, AppState>,
    item_id: i64,
    delta_milli: i64,
    reason: String,
    created_at: String,
    session: Option<String>,
) -> Result<i64, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let actor = state.auth.authorize(&conn, "adjust_stock", session.as_deref())?;
    let out = repo::adjust_stock(&mut conn, item_id, delta_milli, &reason, &created_at)?;
    auth::audit(&conn, actor, "adjust_stock", format!("item {item_id}, {delta_milli} milli-units, {reason}"));
    Ok(out)
}

#[tauri::command]
fn create_bill(
    state: tauri::State<'_, AppState>,
    bill: repo::NewBillPayload,
) -> Result<repo::CreatedBill, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::create_bill(&mut conn, &bill)
}

#[tauri::command]
fn void_bill(
    state: tauri::State<'_, AppState>,
    bill_id: i64,
    reason: String,
    voided_at: String,
    session: Option<String>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let actor = state.auth.authorize(&conn, "void_bill", session.as_deref())?;
    let out = repo::void_bill(&mut conn, bill_id, &reason, &voided_at)?;
    auth::audit(&conn, actor, "void_bill", format!("bill {bill_id}: {reason}"));
    Ok(out)
}

#[tauri::command]
fn create_credit_note(
    state: tauri::State<'_, AppState>,
    credit_note: repo::NewCreditNotePayload,
    session: Option<String>,
) -> Result<repo::CreatedCreditNote, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let actor = state.auth.authorize(&conn, "create_credit_note", session.as_deref())?;
    let out = repo::create_credit_note(&mut conn, &credit_note)?;
    auth::audit(&conn, actor, "create_credit_note", format!("bill {}: {}", credit_note.bill_id, credit_note.reason));
    Ok(out)
}

#[tauri::command]
fn list_credit_notes(
    state: tauri::State<'_, AppState>,
    bill_id: Option<i64>,
) -> Result<Vec<repo::CreditNoteRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::list_credit_notes(&conn, bill_id)
}

#[tauri::command]
fn get_credit_note(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<Option<repo::CreditNoteRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::get_credit_note(&conn, id)
}

#[tauri::command]
fn upsert_supplier(
    state: tauri::State<'_, AppState>,
    supplier: repo::SupplierPayload,
    session: Option<String>,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    state.auth.authorize(&conn, "upsert_supplier", session.as_deref())?;
    repo::upsert_supplier(&conn, &supplier)
}

#[tauri::command]
fn list_suppliers(
    state: tauri::State<'_, AppState>,
    search: Option<String>,
) -> Result<Vec<repo::SupplierRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::list_suppliers(&conn, search)
}

#[tauri::command]
fn delete_supplier(
    state: tauri::State<'_, AppState>,
    supplier_id: i64,
    session: Option<String>,
) -> Result<bool, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let actor = state.auth.authorize(&conn, "delete_supplier", session.as_deref())?;
    let out = repo::delete_supplier(&conn, supplier_id)?;
    auth::audit(&conn, actor, "delete_supplier", format!("supplier {supplier_id}"));
    Ok(out)
}

#[tauri::command]
fn create_purchase(
    state: tauri::State<'_, AppState>,
    purchase: repo::NewPurchasePayload,
    session: Option<String>,
) -> Result<i64, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let actor = state.auth.authorize(&conn, "create_purchase", session.as_deref())?;
    let out = repo::create_purchase(&mut conn, &purchase)?;
    auth::audit(&conn, actor, "create_purchase", format!("purchase from supplier {}", purchase.supplier_id));
    Ok(out)
}

#[tauri::command]
fn list_purchases(
    state: tauri::State<'_, AppState>,
    supplier_id: Option<i64>,
) -> Result<Vec<repo::PurchaseRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::list_purchases(&conn, supplier_id)
}

#[tauri::command]
fn get_purchase(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<Option<repo::PurchaseRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::get_purchase(&conn, id)
}

#[tauri::command]
fn upsert_user(
    state: tauri::State<'_, AppState>,
    user: repo::UserPayload,
    session: Option<String>,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let actor = state.auth.authorize(&conn, "upsert_user", session.as_deref())?;
    let out = repo::upsert_user(&conn, &user)?;
    auth::audit(&conn, actor, "upsert_user", format!("user {} ({}, {})", user.name, user.role, if user.id.is_some() { "edited" } else { "added" }));
    Ok(out)
}

#[tauri::command]
fn list_users(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<repo::UserRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::list_users(&conn)
}

#[tauri::command]
fn verify_pin(
    state: tauri::State<'_, AppState>,
    pin: String,
    required_role: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    auth::login(&state.auth, &conn, &pin, required_role.as_deref())
}

#[tauri::command]
fn logout(state: tauri::State<'_, AppState>) -> Result<(), String> {
    // The window has a single operator at a time, so locking ends every desktop session.
    state.auth.clear_sessions();
    Ok(())
}

#[tauri::command]
fn record_audit_log(
    state: tauri::State<'_, AppState>,
    audit_log: repo::AuditLogPayload,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::record_audit_log(&conn, &audit_log)
}

#[tauri::command]
fn list_audit_logs(
    state: tauri::State<'_, AppState>,
    limit: Option<i64>,
    session: Option<String>,
) -> Result<Vec<repo::AuditLogRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    state.auth.authorize(&conn, "list_audit_logs", session.as_deref())?;
    repo::list_audit_logs(&conn, limit)
}

#[tauri::command]
fn apply_stock_audit(
    state: tauri::State<'_, AppState>,
    discrepancies: Vec<repo::StockDiscrepancyPayload>,
    session: Option<String>,
) -> Result<i64, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let actor = state.auth.authorize(&conn, "apply_stock_audit", session.as_deref())?;
    let out = repo::apply_stock_audit(&mut conn, &discrepancies)?;
    auth::audit(&conn, actor, "apply_stock_audit", format!("{} items counted", discrepancies.len()));
    Ok(out)
}

#[tauri::command]
fn record_publish(
    state: tauri::State<'_, AppState>,
    outcomes: Vec<repo::PublishOutcomePayload>,
    category_mappings: Vec<repo::CategoryMappingPayload>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::record_publish(&mut conn, &outcomes, &category_mappings)
}

// ---------------------------------------------------------------------------
// B2 images, B1 held bills, B5 sync.
// ---------------------------------------------------------------------------

#[tauri::command]
fn set_item_photo(
    state: tauri::State<'_, AppState>,
    item_id: i64,
    bytes: Vec<u8>,
    image_hash: String,
    now: String,
) -> Result<String, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::set_item_photo(&conn, &state.data_dir, item_id, &bytes, &image_hash, &now)
}

#[tauri::command]
fn clear_item_photo(
    state: tauri::State<'_, AppState>,
    item_id: i64,
    now: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::clear_item_photo(&conn, &state.data_dir, item_id, &now)
}

#[tauri::command]
fn read_item_photo(state: tauri::State<'_, AppState>, item_id: i64) -> Result<Vec<u8>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let file: String = conn
        .query_row(
            "SELECT photo_path FROM items WHERE id = ?1",
            rusqlite::params![item_id],
            |r| r.get(0),
        )
        .map_err(|_| format!("no item with id {item_id}"))?;
    if file.is_empty() {
        return Err("this item has no photo".to_string());
    }
    media::read_photo(&state.data_dir, &file)
}

#[tauri::command]
fn record_image_uploads(
    state: tauri::State<'_, AppState>,
    uploads: Vec<repo::ImageUploadPayload>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let rows: Vec<(i64, String, String)> = uploads
        .into_iter()
        .map(|u| (u.item_id, u.image_hash, u.uploaded_at))
        .collect();
    repo::record_image_uploads(&conn, &rows)
}

#[tauri::command]
fn save_held_bill(
    state: tauri::State<'_, AppState>,
    bill: repo::HeldBillPayload,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::save_held_bill(&conn, &bill)
}

#[tauri::command]
fn take_held_bill(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::take_held_bill(&conn, id)
}

#[tauri::command]
fn get_app_setting(state: tauri::State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    sync::get_setting(&conn, &key)
}

#[tauri::command]
fn set_app_setting(
    state: tauri::State<'_, AppState>,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    sync::set_setting(&conn, &key, value)
}

#[tauri::command]
fn set_sync_cursor(state: tauri::State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    sync::set_cursor(&conn, &key, &value)
}

#[tauri::command]
fn enqueue_stock_outbox(
    state: tauri::State<'_, AppState>,
    moves: Vec<repo::OutboxMovePayload>,
) -> Result<Vec<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = moves
        .into_iter()
        .map(|m| (m.payload_json, m.idempotency_key))
        .collect();
    sync::enqueue_stock_outbox(&conn, &rows)
}

#[tauri::command]
fn record_outbox_results(
    state: tauri::State<'_, AppState>,
    results: Vec<repo::OutboxResultPayload>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, Option<String>)> = results
        .into_iter()
        .map(|r| (r.idempotency_key, r.outcome, r.next_attempt_at))
        .collect();
    sync::record_outbox_result(&conn, &rows)
}

#[tauri::command]
fn drop_outbox(state: tauri::State<'_, AppState>, keys: Vec<String>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    sync::drop_outbox(&conn, &keys)
}

#[tauri::command]
fn apply_stock_pull(
    state: tauri::State<'_, AppState>,
    cursor: String,
    moves: Vec<sync::RemoteStockMovePayload>,
) -> Result<Vec<sync::AppliedRemoteMove>, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    sync::apply_stock_pull(&mut conn, &cursor, &moves)
}

#[tauri::command]
fn record_remote_catalog(
    state: tauri::State<'_, AppState>,
    items: Vec<sync::RemoteItemPayload>,
) -> Result<usize, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    sync::record_remote_catalog(&conn, &items)
}

#[tauri::command]
fn record_orders(
    state: tauri::State<'_, AppState>,
    orders: Vec<sync::RemoteOrderPayload>,
) -> Result<usize, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    sync::record_orders(&mut conn, &orders)
}

#[tauri::command]
fn apply_reconcile_fixes(
    state: tauri::State<'_, AppState>,
    fixes: Vec<reconcile::ReconcileFixPayload>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    reconcile::apply_reconcile_fixes(&mut conn, &fixes)
}

// ---------------------------------------------------------------------------
// B3 backup/restore filesystem.
// ---------------------------------------------------------------------------

#[tauri::command]
fn data_dir(state: tauri::State<'_, AppState>) -> Result<String, String> {
    Ok(state.data_dir.display().to_string())
}

#[tauri::command]
fn db_snapshot(state: tauri::State<'_, AppState>) -> Result<Vec<u8>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    drop(conn);
    backup::snapshot(&state.db_path, &state.data_dir.join("tmp"))
}

#[tauri::command]
fn write_backup_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    backup::write_file(std::path::Path::new(&path), &bytes)
}

#[tauri::command]
fn read_backup_file(path: String) -> Result<Vec<u8>, String> {
    backup::read_file(std::path::Path::new(&path), MAX_FILE_BYTES)
}

#[tauri::command]
fn backup_file_info(path: String) -> Result<Option<u64>, String> {
    Ok(backup::file_modified_secs(std::path::Path::new(&path)))
}

#[tauri::command]
fn same_volume(state: tauri::State<'_, AppState>, path: String) -> Result<Option<bool>, String> {
    Ok(backup::same_volume(&state.data_dir, std::path::Path::new(&path)))
}

#[tauri::command]
fn restore_snapshot(state: tauri::State<'_, AppState>, gz: Vec<u8>) -> Result<String, String> {
    if state.restoring.swap(true, Ordering::SeqCst) {
        return Err("a restore is already running".to_string());
    }
    let result = (|| {
        let raw = backup::decompress_snapshot(&gz, MAX_FILE_BYTES)?;
        let keep = backup::replace_database(&state.data_dir, &state.db_path, &raw)?;
        Ok(keep.display().to_string())
    })();
    state.restoring.store(false, Ordering::SeqCst);
    result
}


// --- Master backup (bundle v2): raw binary IPC so photo-sized payloads do not
// round-trip through JSON number arrays. ---------------------------------

fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3).ok_or("bad path header")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "bad path header")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "bad path header".to_string())
}

fn raw_body(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        _ => Err("expected a binary request body".to_string()),
    }
}

fn path_header(request: &tauri::ipc::Request<'_>) -> Result<PathBuf, String> {
    let value = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing path")?;
    Ok(PathBuf::from(percent_decode(value)?))
}

/// Database snapshot + all photos, packed as a v2 bundle.
#[tauri::command]
fn bundle_snapshot(state: tauri::State<'_, AppState>) -> Result<tauri::ipc::Response, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    drop(conn);
    let bytes = backup::build_bundle(
        &state.db_path,
        &state.data_dir.join("tmp"),
        &media::photos_dir(&state.data_dir),
    )?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn read_backup_raw(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = backup::read_file(std::path::Path::new(&path), MAX_FILE_BYTES)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Body = file bytes; `x-path` header = percent-encoded destination.
#[tauri::command]
fn write_backup_raw(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = path_header(&request)?;
    backup::write_file(&path, &raw_body(&request)?)
}

/// Body = decrypted plaintext (v2 bundle or legacy v1 gzip). Returns the
/// pre-restore database copy path.
#[tauri::command]
fn restore_backup(
    state: tauri::State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let plain = raw_body(&request)?;
    if state.restoring.swap(true, Ordering::SeqCst) {
        return Err("a restore is already running".to_string());
    }
    let result = backup::restore_plaintext(
        &state.data_dir,
        &state.db_path,
        &media::photos_dir(&state.data_dir),
        &plain,
        MAX_FILE_BYTES,
    )
    .map(|keep| keep.display().to_string());
    state.restoring.store(false, Ordering::SeqCst);
    result
}

// ---------------------------------------------------------------------------
// Phase 3 Smart-Merchant Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn upsert_batch(
    state: tauri::State<'_, AppState>,
    batch: repo::BatchPayload,
) -> Result<i64, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::upsert_batch(&mut conn, &batch)
}

#[tauri::command]
fn list_batches_for_item(
    state: tauri::State<'_, AppState>,
    item_id: i64,
) -> Result<Vec<repo::BatchRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::list_batches_for_item(&conn, item_id)
}

#[tauri::command]
fn list_expiring_batches(
    state: tauri::State<'_, AppState>,
    days_threshold: i64,
    now_iso: String,
) -> Result<Vec<repo::BatchRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::list_expiring_batches(&conn, days_threshold, &now_iso)
}

#[tauri::command]
fn update_customer_loyalty(
    state: tauri::State<'_, AppState>,
    customer_id: i64,
    points_delta: i64,
    bill_id: Option<i64>,
    reason: String,
    created_at: String,
) -> Result<i64, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::update_customer_loyalty(&mut conn, customer_id, points_delta, bill_id, &reason, &created_at)
}

#[tauri::command]
fn get_customer_loyalty_balance(
    state: tauri::State<'_, AppState>,
    customer_id: i64,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::get_customer_loyalty_balance(&conn, customer_id)
}

#[tauri::command]
fn list_loyalty_transactions(
    state: tauri::State<'_, AppState>,
    customer_id: i64,
) -> Result<Vec<repo::LoyaltyTransactionRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::list_loyalty_transactions(&conn, customer_id)
}

#[tauri::command]
fn upsert_item_barcode(
    state: tauri::State<'_, AppState>,
    item_id: i64,
    barcode: String,
    pack_qty_milli: i64,
    label: String,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::upsert_item_barcode(&conn, item_id, &barcode, pack_qty_milli, &label)
}

#[tauri::command]
fn list_item_barcodes(
    state: tauri::State<'_, AppState>,
    item_id: i64,
) -> Result<Vec<repo::ItemBarcodeRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::list_item_barcodes(&conn, item_id)
}

#[tauri::command]
fn delete_item_barcode(
    state: tauri::State<'_, AppState>,
    barcode_id: i64,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::delete_item_barcode(&conn, barcode_id)
}

#[tauri::command]
fn lookup_item_by_any_barcode(
    state: tauri::State<'_, AppState>,
    barcode: String,
) -> Result<Option<repo::BarcodeLookupRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::lookup_item_by_any_barcode(&conn, &barcode)
}

#[tauri::command]
fn create_day_end_closure(
    state: tauri::State<'_, AppState>,
    closure: repo::DayEndClosurePayload,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::create_day_end_closure(&conn, &closure)
}

#[tauri::command]
fn list_day_end_closures(
    state: tauri::State<'_, AppState>,
    from_date: Option<String>,
    to_date: Option<String>,
) -> Result<Vec<repo::DayEndClosureRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::list_day_end_closures(&conn, from_date.as_deref(), to_date.as_deref())
}

#[tauri::command]
fn get_day_end_expected_cash(
    state: tauri::State<'_, AppState>,
    date_prefix: String,
) -> Result<repo::DayEndExpectedCashRow, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::get_day_end_expected_cash(&conn, &date_prefix)
}

#[tauri::command]
fn lan_server_status(
    server_mgr: tauri::State<'_, server::LanServerManager>,
) -> server::LanServerStatus {
    server_mgr.status()
}

#[tauri::command]
fn lan_server_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    server_mgr: tauri::State<'_, server::LanServerManager>,
    port: u16,
) -> Result<server::LanServerStatus, String> {
    server_mgr.start(&app, &state, port)
}

#[tauri::command]
fn lan_server_stop(
    server_mgr: tauri::State<'_, server::LanServerManager>,
) -> Result<server::LanServerStatus, String> {
    server_mgr.stop()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(driver_script: Option<String>) {
    let script = driver_script.map(std::sync::Arc::new);
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_page_load(move |win, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Some(script) = script.as_deref() {
                    let js = format!("{script};setTimeout(() => window.__MTC_DRIVER__.run(), 1500);");
                    match win.eval(&js) {
                        Ok(()) => eprintln!("[driver] evaluated {} chars", js.len()),
                        Err(e) => eprintln!("[driver] eval failed: {e}"),
                    }
                }
            }
        })
        .setup(move |app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
            let db_path = data_dir.join(db::DB_FILE_NAME);
            let outcome = db::migrate(&db_path).map_err(|e| e.to_string())?;
            if outcome.to_version > outcome.from_version {
                eprintln!(
                    "db migrated v{} -> v{} (backup: {:?})",
                    outcome.from_version, outcome.to_version, outcome.backup_path
                );
            }
            let conn = db::open(&db_path).map_err(|e| e.to_string())?;
            let app_state = AppState {
                data_dir,
                db_path,
                conn: Arc::new(Mutex::new(conn)),
                restoring: Arc::new(AtomicBool::new(false)),
                auth: Arc::new(auth::Auth::default()),
            };
            if let Ok(c) = app_state.conn.lock() {
                if let Err(e) = auth::upgrade_legacy_pins(&c) {
                    eprintln!("[auth] could not hash legacy PINs: {e}");
                }
            }
            app.manage(app_state.clone());

            let server_mgr = server::LanServerManager::new();
            if let Ok(c) = app_state.conn.lock() {
                let autostart = sync::get_setting(&c, "lan.autostart")
                    .ok()
                    .flatten()
                    .map(|v| v == "true" || v == "1")
                    .unwrap_or(false);
                let port = sync::get_setting(&c, "lan.port")
                    .ok()
                    .flatten()
                    .and_then(|p| p.parse::<u16>().ok())
                    .unwrap_or(8080);
                drop(c);
                if autostart {
                    if let Err(e) = server_mgr.start(&app.handle().clone(), &app_state, port) {
                        eprintln!("[lan_server] autostart failed: {e}");
                    }
                }
            }
            app.manage(server_mgr);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lan_server_status,
            lan_server_start,
            lan_server_stop,
            db_status,
            db_hello,
            keychain_set,
            keychain_get,
            keychain_delete,
            query_rows,
            save_shop_profile,
            upsert_category,
            upsert_customer,
            delete_customer,
            record_customer_payment,
            list_customer_payments,
            get_bills_report_data,
            upsert_item,
            import_items,
            adjust_stock,
            create_bill,
            void_bill,
            create_credit_note,
            list_credit_notes,
            get_credit_note,
            upsert_supplier,
            list_suppliers,
            delete_supplier,
            create_purchase,
            list_purchases,
            get_purchase,
            upsert_user,
            list_users,
            verify_pin,
            logout,
            record_audit_log,
            list_audit_logs,
            apply_stock_audit,
            record_publish,
            set_item_photo,
            clear_item_photo,
            read_item_photo,
            record_image_uploads,
            save_held_bill,
            take_held_bill,
            get_app_setting,
            set_app_setting,
            set_sync_cursor,
            enqueue_stock_outbox,
            record_outbox_results,
            drop_outbox,
            apply_stock_pull,
            record_remote_catalog,
            record_orders,
            apply_reconcile_fixes,
            data_dir,
            db_snapshot,
            write_backup_file,
            read_backup_file,
            backup_file_info,
            same_volume,
            restore_snapshot,
            bundle_snapshot,
            read_backup_raw,
            write_backup_raw,
            restore_backup,
            upsert_batch,
            list_batches_for_item,
            list_expiring_batches,
            update_customer_loyalty,
            get_customer_loyalty_balance,
            list_loyalty_transactions,
            upsert_item_barcode,
            list_item_barcodes,
            delete_item_barcode,
            lookup_item_by_any_barcode,
            create_day_end_closure,
            list_day_end_closures,
            get_day_end_expected_cash,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MyTownCart Billing");
}
