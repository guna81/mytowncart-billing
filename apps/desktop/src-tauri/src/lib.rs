// SPDX-License-Identifier: Apache-2.0
//! Tauri 2 shell for MyTownCart Billing: owns the SQLite database
//! (forward-only migrations with a pre-migration backup copy) and the OS
//! keychain. The web UI reaches both only through these commands.
//!
//! Reads go through the generic parameterized `query_rows` command; every
//! multi-table write is a dedicated typed command running in ONE
//! transaction (see `repo.rs`).

mod backup;
mod db;
mod keychain;
mod media;
mod reconcile;
mod repo;
mod sync;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

/// Upper bound for anything read from disk into memory (backups, photos).
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

struct AppState {
    data_dir: PathBuf,
    db_path: PathBuf,
    /// Single shared connection. Commands that write take the mutex and run
    /// their whole transaction under it; a busy_timeout covers any reader
    /// connections (e.g. the B0 `db_status` path) racing a writer.
    conn: Mutex<rusqlite::Connection>,
    /// Set while a restore swaps the database file; every other command
    /// refuses to run so no write lands in the discarded file.
    restoring: AtomicBool,
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
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
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
fn upsert_item(state: tauri::State<'_, AppState>, item: repo::ItemPayload) -> Result<i64, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::upsert_item(&mut conn, &item)
}

#[tauri::command]
fn import_items(
    state: tauri::State<'_, AppState>,
    items: Vec<repo::ItemPayload>,
) -> Result<Vec<repo::ImportRowResult>, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::import_items(&mut conn, &items)
}

#[tauri::command]
fn adjust_stock(
    state: tauri::State<'_, AppState>,
    item_id: i64,
    delta_milli: i64,
    reason: String,
    created_at: String,
) -> Result<i64, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::adjust_stock(&mut conn, item_id, delta_milli, &reason, &created_at)
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
) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    repo::void_bill(&mut conn, bill_id, &reason, &voided_at)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(driver_script: Option<String>) {
    let script = driver_script.map(std::sync::Arc::new);
    tauri::Builder::default()
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
            app.manage(AppState {
                data_dir,
                db_path,
                conn: Mutex::new(conn),
                restoring: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_status,
            db_hello,
            keychain_set,
            keychain_get,
            keychain_delete,
            query_rows,
            save_shop_profile,
            upsert_category,
            upsert_customer,
            upsert_item,
            import_items,
            adjust_stock,
            create_bill,
            void_bill,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running MyTownCart Billing");
}
