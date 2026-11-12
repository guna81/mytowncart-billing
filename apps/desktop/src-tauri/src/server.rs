// SPDX-License-Identifier: Apache-2.0
//! Embedded Local Web Server (LAN / Mobile POS) for MyTownCart Billing.
//! Serves the web UI and exposes an HTTP invoke endpoint connected to the local SQLite database.

use std::io::Read;
use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::Serialize;
use tiny_http::{Header, Method, Request, Response, Server};

use crate::{media, repo, sync, AppState};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LanServerStatus {
    pub running: bool,
    pub port: u16,
    pub urls: Vec<String>,
}

pub struct LanServerManager {
    running: Arc<AtomicBool>,
    port: Arc<Mutex<u16>>,
    thread_handle: Mutex<Option<JoinHandle<()>>>,
    /// Per-start secret required on /api/invoke (sent as `X-MTC-Key`).
    token: Arc<Mutex<String>>,
}

impl Default for LanServerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LanServerManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            port: Arc::new(Mutex::new(8080)),
            thread_handle: Mutex::new(None),
            token: Arc::new(Mutex::new(String::new())),
        }
    }

    pub fn status(&self) -> LanServerStatus {
        let running = self.running.load(Ordering::Relaxed);
        let port = *self.port.lock().unwrap_or_else(|e| e.into_inner());
        let token = self.token.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let urls = if running {
            compute_server_urls(port, &token)
        } else {
            Vec::new()
        };
        LanServerStatus {
            running,
            port,
            urls,
        }
    }

    pub fn stop(&self) -> Result<LanServerStatus, String> {
        self.running.store(false, Ordering::Relaxed);
        if let Ok(mut handle_guard) = self.thread_handle.lock() {
            if let Some(handle) = handle_guard.take() {
                let _ = handle.join();
            }
        }
        Ok(self.status())
    }

    pub fn start(
        &self,
        app_handle: &tauri::AppHandle,
        state: &AppState,
        port: u16,
    ) -> Result<LanServerStatus, String> {
        let _ = self.stop();

        let server = Server::http(format!("0.0.0.0:{port}"))
            .map_err(|e| format!("cannot bind web server to port {port}: {e}"))?;

        if let Ok(mut p) = self.port.lock() {
            *p = port;
        }
        let token = generate_token()?;
        if let Ok(mut t) = self.token.lock() {
            *t = token.clone();
        }
        self.running.store(true, Ordering::Relaxed);

        let running_clone = Arc::clone(&self.running);
        let app_handle_clone = app_handle.clone();
        let app_state_clone = state.clone();

        let handle = thread::spawn(move || {
            run_server_loop(server, running_clone, app_handle_clone, app_state_clone, token);
        });

        if let Ok(mut handle_guard) = self.thread_handle.lock() {
            *handle_guard = Some(handle);
        }

        Ok(self.status())
    }
}

fn compute_server_urls(port: u16, token: &str) -> Vec<String> {
    let mut urls = Vec::new();
    if let Some(ip) = get_local_ip() {
        urls.push(format!("http://{ip}:{port}/?key={token}"));
    }
    urls.push(format!("http://localhost:{port}/?key={token}"));
    urls
}

/// 128-bit random access key, hex-encoded. A fresh key is issued on every start.
fn generate_token() -> Result<String, String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(|e| format!("cannot generate LAN access key: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn token_matches(provided: &str, expected: &str) -> bool {
    if expected.is_empty() || provided.len() != expected.len() {
        return false;
    }
    provided
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn get_local_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

fn run_server_loop(
    server: Server,
    running: Arc<AtomicBool>,
    app_handle: tauri::AppHandle,
    state: AppState,
    token: String,
) {
    while running.load(Ordering::Relaxed) {
        match server.recv_timeout(Duration::from_millis(200)) {
            Ok(Some(request)) => {
                handle_http_request(request, &app_handle, &state, &token);
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("[lan_server] recv error: {e}");
                break;
            }
        }
    }
}

fn handle_http_request(
    mut request: Request,
    app_handle: &tauri::AppHandle,
    state: &AppState,
    token: &str,
) {
    let url_str = request.url().to_string();
    let path = url_str.split('?').next().unwrap_or("").trim_start_matches('/');

    // Handle CORS preflight
    if request.method() == &Method::Options {
        // The UI is served from this same origin, so cross-origin access is never
        // granted: no Access-Control-* headers.
        let resp = Response::empty(403);
        let _ = request.respond(resp);
        return;
    }

    // Health endpoint
    if path == "api/health" {
        let body = serde_json::json!({
            "status": "ok",
            "app": "mytowncart-billing",
            "mode": "lan-server"
        });
        let resp = Response::from_string(body.to_string())
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
        let _ = request.respond(resp);
        return;
    }

    if path == "api/marketplace/connection" || path.starts_with("api/marketplace/proxy/") {
        let provided = request.headers().iter().find(|h| h.field.equiv("X-MTC-Key"))
            .map(|h| h.value.as_str()).unwrap_or("");
        if !token_matches(provided, token) {
            let _ = request.respond(Response::from_string("Unauthorized").with_status_code(401));
            return;
        }
        let session = request.headers().iter().find(|h| h.field.equiv("X-MTC-Session"))
            .map(|h| h.value.as_str().to_string());
        let command = if path == "api/marketplace/connection" && request.method() == &Method::Delete {
            "marketplace_disconnect"
        } else if path.starts_with("api/marketplace/proxy/connect/") {
            "marketplace_connect"
        } else {
            "marketplace_request"
        };
        let authorized = state.conn.lock().map_err(|e| e.to_string())
            .and_then(|conn| state.auth.authorize(&conn, command, session.as_deref()).map(|_| ()));
        if let Err(err) = authorized {
            let _ = request.respond(Response::from_string(err).with_status_code(403));
            return;
        }
        let response = marketplace_request(&mut request, &url_str, path);
        let _ = request.respond(response);
        return;
    }

    // Photo direct endpoint: /api/photos/{itemId}?key=TOKEN (an <img> tag cannot send headers)
    if let Some(id_str) = path.strip_prefix("api/photos/") {
        let from_query = url_str
            .split_once('?')
            .map(|(_, q)| q)
            .unwrap_or("")
            .split('&')
            .find_map(|kv| kv.strip_prefix("key="))
            .unwrap_or("");
        let from_header = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("X-MTC-Key"))
            .map(|h| h.value.as_str().to_string())
            .unwrap_or_default();
        if !token_matches(from_query, token) && !token_matches(&from_header, token) {
            let _ = request.respond(Response::from_string("Unauthorized").with_status_code(401));
            return;
        }
        if let Ok(item_id) = id_str.parse::<i64>() {
            if let Ok(bytes) = read_item_photo_bytes(state, item_id) {
                let resp = Response::from_data(bytes)
                    .with_header(Header::from_bytes("Content-Type", "image/jpeg").unwrap())
                    .with_header(Header::from_bytes("Cache-Control", "private, max-age=3600").unwrap());
                let _ = request.respond(resp);
                return;
            }
        }
        let resp = Response::from_string("Photo not found").with_status_code(404);
        let _ = request.respond(resp);
        return;
    }

    // RPC invoke endpoint: POST /api/invoke
    if path == "api/invoke" {
        if request.method() != &Method::Post {
            let resp = Response::from_string("Method Not Allowed")
                .with_status_code(405);
            let _ = request.respond(resp);
            return;
        }

        let provided = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("X-MTC-Key"))
            .map(|h| h.value.as_str().to_string())
            .unwrap_or_default();
        if !token_matches(&provided, token) {
            let _ = request.respond(Response::from_string("Unauthorized").with_status_code(401));
            return;
        }

        let mut body_str = String::new();
        if let Err(e) = request.as_reader().read_to_string(&mut body_str) {
            let resp = Response::from_string(format!("Failed to read body: {e}"))
                .with_status_code(400);
            let _ = request.respond(resp);
            return;
        }

        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&body_str);
        match parsed {
            Ok(json) => {
                let cmd = json
                    .get("cmd")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let args = json.get("args").cloned().unwrap_or(serde_json::Value::Null);

                let session = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("X-MTC-Session"))
                    .map(|h| h.value.as_str().to_string());
                match dispatch_invoke(state, &cmd, args, session.as_deref()) {
                    Ok(res) => {
                        let resp_body = serde_json::to_string(&res).unwrap_or_default();
                        let resp = Response::from_string(resp_body)
                            .with_header(
                                Header::from_bytes("Content-Type", "application/json").unwrap(),
                            );
                        let _ = request.respond(resp);
                    }
                    Err(err) => {
                        let resp = Response::from_string(err)
                            .with_status_code(400)
                            .with_header(
                                Header::from_bytes("Content-Type", "text/plain").unwrap(),
                            );
                        let _ = request.respond(resp);
                    }
                }
            }
            Err(e) => {
                let resp = Response::from_string(format!("Invalid JSON: {e}"))
                    .with_status_code(400);
                let _ = request.respond(resp);
            }
        }
        return;
    }

    // Static assets
    serve_static_asset(request, app_handle, path);
}

const MARKETPLACE_KEY: &str = "mytowncart.integration";

const PROD_MARKETPLACE_API: &str = "https://api.mytowncart.com/api/v1/integrations";

/// Where the LAN web view's marketplace calls are forwarded. Always production
/// in release builds. Debug builds may point at a local backend with
/// `MTC_DEV_API_URL`, but only a loopback http(s) address is honoured, so the
/// stored token can never be redirected to another host.
fn marketplace_api_base() -> String {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("MTC_DEV_API_URL") {
        if is_loopback_url(&url) {
            return url.trim_end_matches('/').to_string();
        }
    }
    PROD_MARKETPLACE_API.to_string()
}

#[cfg(any(debug_assertions, test))]
fn is_loopback_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://")) else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.contains('@') {
        return false;
    }
    let name = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    matches!(name, "localhost" | "127.0.0.1")
}

fn marketplace_request(request: &mut Request, url: &str, path: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    fn error(status: u16, message: &str) -> Response<std::io::Cursor<Vec<u8>>> {
        Response::from_string(message).with_status_code(status)
    }
    if path == "api/marketplace/connection" {
        return match request.method() {
            Method::Get => match crate::keychain::get(MARKETPLACE_KEY) {
                Ok(value) => {
                    let safe = value.and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
                        .filter(|v| v.is_object() && v.get("token").and_then(|t| t.as_str()).is_some_and(|t| !t.is_empty()))
                        .map(|mut v| { v["token"] = "host-managed".into(); v.to_string() });
                    Response::from_string(serde_json::to_string(&safe).unwrap_or_else(|_| "null".into()))
                        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
                }
                Err(_) => error(500, "Could not read the marketplace connection from the credential store."),
            },
            Method::Delete => match crate::keychain::delete(MARKETPLACE_KEY) {
                Ok(()) => Response::from_string("null").with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
                Err(_) => error(500, "Could not remove the marketplace connection from the credential store."),
            },
            _ => error(405, "Method not allowed"),
        };
    }
    let suffix = path.strip_prefix("api/marketplace/proxy").unwrap_or("");
    // Restrict the proxy to the integration API and never allow URL traversal.
    if suffix.contains("..") || suffix.contains('%') || suffix.contains('\\') || suffix.is_empty() {
        return error(400, "Invalid marketplace path");
    }
    let method = match request.method() {
        Method::Get => reqwest::Method::GET,
        Method::Post => reqwest::Method::POST,
        _ => return error(405, "Method not allowed"),
    };
    let query = url.split_once('?').map(|(_, q)| format!("?{q}")).unwrap_or_default();
    let target = format!("{}{suffix}{query}", marketplace_api_base());
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none()).build() {
        Ok(c) => c,
        Err(_) => return error(502, "Could not initialize the marketplace connection."),
    };
    let mut outbound = client.request(method, target);
    for h in request.headers() {
        if h.field.equiv("Content-Type") || h.field.equiv("X-App-Version") {
            outbound = outbound.header(h.field.as_str().as_str(), h.value.as_str());
        }
    }
    if !suffix.starts_with("/connect/") {
        let stored = match crate::keychain::get(MARKETPLACE_KEY) {
            Ok(Some(s)) => s,
            Ok(None) => return error(401, "No marketplace connection."),
            Err(_) => return error(500, "Could not read the marketplace connection from the credential store."),
        };
        let secret = serde_json::from_str::<serde_json::Value>(&stored).ok()
            .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(str::to_owned));
        match secret { Some(token) => outbound = outbound.bearer_auth(token), None => return error(500, "Invalid marketplace connection.") }
    }
    let mut body = Vec::new();
    if std::io::Read::read_to_end(&mut request.as_reader().take(12 * 1024 * 1024 + 1), &mut body).is_err() || body.len() > 12 * 1024 * 1024 {
        return error(413, "Marketplace request too large.");
    }
    let response = match outbound.body(body).send() {
        Ok(r) => r,
        Err(_) => return error(502, "Could not reach MyTownCart."),
    };
    let status = response.status().as_u16();
    let mut bytes = match response.bytes() { Ok(b) => b.to_vec(), Err(_) => return error(502, "Could not read MyTownCart response.") };
    if suffix == "/connect/poll/" && status == 200 {
        let mut data: serde_json::Value = match serde_json::from_slice(&bytes) { Ok(v) => v, Err(_) => return error(502, "Invalid marketplace response.") };
        let Some(secret) = data.get("token").and_then(|v| v.as_str()) else { return error(502, "Marketplace did not issue a token.") };
        let saved = serde_json::json!({"token": secret, "sellerName": data["seller"]["name"], "sellerIsApproved": data["seller"]["is_approved"], "scopes": data["scopes"]});
        if crate::keychain::set(MARKETPLACE_KEY, &saved.to_string()).is_err() {
            return error(500, "Could not save the marketplace connection in the credential store. Please connect again.");
        }
        data["token"] = "host-managed".into();
        bytes = data.to_string().into_bytes();
    }
    Response::from_data(bytes).with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
}

fn read_item_photo_bytes(state: &AppState, item_id: i64) -> Result<Vec<u8>, String> {
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

fn serve_static_asset(
    request: Request,
    app_handle: &tauri::AppHandle,
    raw_path: &str,
) {
    let clean_path = if raw_path.is_empty() || raw_path == "/" {
        "index.html"
    } else {
        raw_path
    };

    if let Some((mut bytes, mime)) = get_asset(app_handle, clean_path) {
        if clean_path == "index.html" || clean_path.ends_with("/index.html") {
            if let Ok(html) = String::from_utf8(bytes.clone()) {
                let injected = html.replace(
                    "<head>",
                    "<head><script>window.__MTC_LAN_SERVER__ = true;</script>",
                );
                bytes = injected.into_bytes();
            }
        }

        let resp = Response::from_data(bytes)
            .with_header(Header::from_bytes("Content-Type", mime).unwrap());
        let _ = request.respond(resp);
        return;
    }

    // SPA fallback: If requesting a route without file extension, serve index.html
    if !clean_path.contains('.') {
        if let Some((mut bytes, mime)) = get_asset(app_handle, "index.html") {
            if let Ok(html) = String::from_utf8(bytes.clone()) {
                let injected = html.replace(
                    "<head>",
                    "<head><script>window.__MTC_LAN_SERVER__ = true;</script>",
                );
                bytes = injected.into_bytes();
            }
            let resp = Response::from_data(bytes)
                .with_header(Header::from_bytes("Content-Type", mime).unwrap());
            let _ = request.respond(resp);
            return;
        }
    }

    let resp = Response::from_string("Not Found").with_status_code(404);
    let _ = request.respond(resp);
}

fn get_asset(app_handle: &tauri::AppHandle, path: &str) -> Option<(Vec<u8>, &'static str)> {
    let mime = mime_for_path(path);

    // 1. Try Tauri asset resolver (compiled bundle in release)
    if let Some(asset) = app_handle.asset_resolver().get(path.to_string()) {
        return Some((asset.bytes, mime));
    }

    // 2. Fallback to dist directory paths (development / local checkout)
    let candidate_dirs = [
        PathBuf::from("../../web/dist"),
        PathBuf::from("../web/dist"),
        PathBuf::from("apps/web/dist"),
        PathBuf::from("web/dist"),
        PathBuf::from("dist"),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("dist")))
            .unwrap_or_default(),
    ];

    for dir in &candidate_dirs {
        let file_path = dir.join(path);
        if file_path.is_file() {
            if let Ok(bytes) = std::fs::read(&file_path) {
                return Some((bytes, mime));
            }
        }
    }

    None
}

fn mime_for_path(path: &str) -> &'static str {
    if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".js") || path.ends_with(".mjs") {
        "application/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".ico") {
        "image/x-icon"
    } else if path.ends_with(".json") {
        "application/json"
    } else if path.ends_with(".woff2") {
        "font/woff2"
    } else if path.ends_with(".woff") {
        "font/woff"
    } else if path.ends_with(".ttf") {
        "font/ttf"
    } else {
        "application/octet-stream"
    }
}

fn get_arg<T: serde::de::DeserializeOwned>(
    args: &serde_json::Value,
    camel: &str,
    snake: &str,
) -> Result<T, String> {
    args.get(camel)
        .or_else(|| args.get(snake))
        .cloned()
        .ok_or_else(|| format!("missing argument `{camel}`"))
        .and_then(|v| {
            serde_json::from_value(v).map_err(|e| format!("invalid argument `{camel}`: {e}"))
        })
}

fn get_opt_arg<T: serde::de::DeserializeOwned>(
    args: &serde_json::Value,
    camel: &str,
    snake: &str,
) -> Result<Option<T>, String> {
    match args.get(camel).or_else(|| args.get(snake)) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| format!("invalid argument `{camel}`: {e}")),
    }
}

pub fn dispatch_invoke(
    state: &AppState,
    cmd: &str,
    args: serde_json::Value,
    session: Option<&str>,
) -> Result<serde_json::Value, String> {
    // Role check first: nothing below runs for a caller who is not allowed to run it.
    let actor = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        state.auth.authorize(&conn, cmd, session)?
    };
    match cmd {
        "logout" => {
            if let Some(t) = session {
                state.auth.end_session(t);
            }
            Ok(serde_json::Value::Null)
        }
        "query_rows" => {
            let sql: String = get_arg(&args, "sql", "sql")?;
            let params: Vec<serde_json::Value> =
                get_arg(&args, "params", "params").unwrap_or_default();
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let rows = repo::query_rows(&conn, &sql, params)?;
            serde_json::to_value(rows).map_err(|e| e.to_string())
        }
        "save_shop_profile" => {
            let profile: repo::ShopProfilePayload = get_arg(&args, "profile", "profile")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            repo::save_shop_profile(&conn, &profile)?;
            Ok(serde_json::Value::Null)
        }
        "upsert_category" => {
            let category: repo::CategoryPayload = get_arg(&args, "category", "category")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let id = repo::upsert_category(&conn, &category)?;
            serde_json::to_value(id).map_err(|e| e.to_string())
        }
        "upsert_customer" => {
            let customer: repo::CustomerPayload = get_arg(&args, "customer", "customer")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let id = repo::upsert_customer(&conn, &customer)?;
            serde_json::to_value(id).map_err(|e| e.to_string())
        }
        "delete_customer" => {
            let id: i64 = get_arg(&args, "customerId", "customer_id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let res = repo::delete_customer(&conn, id)?;
            crate::auth::audit(&conn, actor, "delete_customer", format!("customer {id}"));
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "record_customer_payment" => {
            let payment: repo::CustomerPaymentPayload = get_arg(&args, "payment", "payment")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let id = repo::record_customer_payment(&conn, &payment)?;
            serde_json::to_value(id).map_err(|e| e.to_string())
        }
        "list_customer_payments" => {
            let customer_id: i64 = get_arg(&args, "customerId", "customer_id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let list = repo::list_customer_payments(&conn, customer_id)?;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "get_bills_report_data" => {
            let from: Option<String> = get_opt_arg(&args, "from", "from")?;
            let to: Option<String> = get_opt_arg(&args, "to", "to")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let list = repo::get_bills_report_data(&conn, from.as_deref(), to.as_deref())?;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "upsert_item" => {
            let item: repo::ItemPayload = get_arg(&args, "item", "item")?;
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            let id = repo::upsert_item(&mut conn, &item)?;
            serde_json::to_value(id).map_err(|e| e.to_string())
        }
        "import_items" => {
            let items: Vec<repo::ItemPayload> = get_arg(&args, "items", "items")?;
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            let res = repo::import_items(&mut conn, &items)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "adjust_stock" => {
            let item_id: i64 = get_arg(&args, "itemId", "item_id")?;
            let delta_milli: i64 = get_arg(&args, "deltaMilli", "delta_milli")?;
            let reason: String = get_arg(&args, "reason", "reason")?;
            let created_at: String = get_arg(&args, "createdAt", "created_at")?;
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            let mov_id =
                repo::adjust_stock(&mut conn, item_id, delta_milli, &reason, &created_at)?;
            crate::auth::audit(&conn, actor, "adjust_stock", format!("item {item_id}, {delta_milli} milli-units, {reason}"));
            serde_json::to_value(mov_id).map_err(|e| e.to_string())
        }
        "create_bill" => {
            let bill: repo::NewBillPayload = get_arg(&args, "bill", "bill")?;
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            let res = repo::create_bill(&mut conn, &bill)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "void_bill" => {
            let bill_id: i64 = get_arg(&args, "billId", "bill_id")?;
            let reason: String = get_arg(&args, "reason", "reason")?;
            let voided_at: String = get_arg(&args, "voidedAt", "voided_at")?;
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            repo::void_bill(&mut conn, bill_id, &reason, &voided_at)?;
            crate::auth::audit(&conn, actor, "void_bill", format!("bill {bill_id}: {reason}"));
            Ok(serde_json::Value::Null)
        }
        "create_credit_note" => {
            let credit_note: repo::NewCreditNotePayload =
                get_arg(&args, "creditNote", "credit_note")?;
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            let res = repo::create_credit_note(&mut conn, &credit_note)?;
            crate::auth::audit(&conn, actor, "create_credit_note", format!("bill {}: {}", credit_note.bill_id, credit_note.reason));
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "list_credit_notes" => {
            let bill_id: Option<i64> = get_opt_arg(&args, "billId", "bill_id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let list = repo::list_credit_notes(&conn, bill_id)?;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "get_credit_note" => {
            let id: i64 = get_arg(&args, "id", "id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let note = repo::get_credit_note(&conn, id)?;
            serde_json::to_value(note).map_err(|e| e.to_string())
        }
        "list_suppliers" => {
            let search: Option<String> = get_opt_arg(&args, "search", "search")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let list = repo::list_suppliers(&conn, search)?;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "upsert_supplier" => {
            let supplier: repo::SupplierPayload = get_arg(&args, "supplier", "supplier")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let id = repo::upsert_supplier(&conn, &supplier)?;
            serde_json::to_value(id).map_err(|e| e.to_string())
        }
        "delete_supplier" => {
            let supplier_id: i64 = get_arg(&args, "supplierId", "supplier_id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let res = repo::delete_supplier(&conn, supplier_id)?;
            crate::auth::audit(&conn, actor, "delete_supplier", format!("supplier {supplier_id}"));
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "create_purchase" => {
            let purchase: repo::NewPurchasePayload = get_arg(&args, "purchase", "purchase")?;
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            let id = repo::create_purchase(&mut conn, &purchase)?;
            crate::auth::audit(&conn, actor, "create_purchase", format!("purchase from supplier {}", purchase.supplier_id));
            serde_json::to_value(id).map_err(|e| e.to_string())
        }
        "list_purchases" => {
            let supplier_id: Option<i64> = get_opt_arg(&args, "supplierId", "supplier_id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let list = repo::list_purchases(&conn, supplier_id)?;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "get_purchase" => {
            let id: i64 = get_arg(&args, "id", "id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let purchase = repo::get_purchase(&conn, id)?;
            serde_json::to_value(purchase).map_err(|e| e.to_string())
        }
        "list_users" => {
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let users = repo::list_users(&conn)?;
            serde_json::to_value(users).map_err(|e| e.to_string())
        }
        "upsert_user" => {
            let user: repo::UserPayload = get_arg(&args, "user", "user")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let id = repo::upsert_user(&conn, &user)?;
            crate::auth::audit(&conn, actor, "upsert_user", format!("user {} ({}, {})", user.name, user.role, if user.id.is_some() { "edited" } else { "added" }));
            serde_json::to_value(id).map_err(|e| e.to_string())
        }
        "verify_pin" => {
            let pin: String = get_arg(&args, "pin", "pin")?;
            let required_role: Option<String> = get_opt_arg(&args, "requiredRole", "required_role")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let user = crate::auth::login(&state.auth, &conn, &pin, required_role.as_deref())?;
            serde_json::to_value(user).map_err(|e| e.to_string())
        }
        "record_audit_log" => {
            let log: repo::AuditLogPayload = get_arg(&args, "auditLog", "audit_log")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let id = repo::record_audit_log(&conn, &log)?;
            serde_json::to_value(id).map_err(|e| e.to_string())
        }
        "list_audit_logs" => {
            let limit: Option<i64> = get_opt_arg(&args, "limit", "limit")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let logs = repo::list_audit_logs(&conn, limit)?;
            serde_json::to_value(logs).map_err(|e| e.to_string())
        }
        "apply_stock_audit" => {
            let discrepancies: Vec<repo::StockDiscrepancyPayload> =
                get_arg(&args, "discrepancies", "discrepancies")?;
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            let count = repo::apply_stock_audit(&mut conn, &discrepancies)?;
            crate::auth::audit(&conn, actor, "apply_stock_audit", format!("{} items counted", discrepancies.len()));
            serde_json::to_value(count).map_err(|e| e.to_string())
        }
        "record_publish" => {
            let outcomes: Vec<repo::PublishOutcomePayload> =
                get_arg(&args, "outcomes", "outcomes")?;
            let category_mappings: Vec<repo::CategoryMappingPayload> =
                get_arg(&args, "categoryMappings", "category_mappings")?;
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            repo::record_publish(&mut conn, &outcomes, &category_mappings)?;
            Ok(serde_json::Value::Null)
        }
        "set_item_photo" => {
            let item_id: i64 = get_arg(&args, "itemId", "item_id")?;
            let bytes: Vec<u8> = get_arg(&args, "bytes", "bytes")?;
            let image_hash: String = get_arg(&args, "imageHash", "image_hash")?;
            let now: String = get_arg(&args, "now", "now")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let path = repo::set_item_photo(&conn, &state.data_dir, item_id, &bytes, &image_hash, &now)?;
            serde_json::to_value(path).map_err(|e| e.to_string())
        }
        "clear_item_photo" => {
            let item_id: i64 = get_arg(&args, "itemId", "item_id")?;
            let now: String = get_arg(&args, "now", "now")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            repo::clear_item_photo(&conn, &state.data_dir, item_id, &now)?;
            Ok(serde_json::Value::Null)
        }
        "read_item_photo" => {
            let item_id: i64 = get_arg(&args, "itemId", "item_id")?;
            let bytes = read_item_photo_bytes(state, item_id)?;
            serde_json::to_value(bytes).map_err(|e| e.to_string())
        }
        "list_item_images" => {
            let item_id: i64 = get_arg(&args, "itemId", "item_id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let list = repo::list_item_images(&conn, item_id)?;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "add_item_image" => {
            let item_id: i64 = get_arg(&args, "itemId", "item_id")?;
            let bytes: Vec<u8> = get_arg(&args, "bytes", "bytes")?;
            let image_hash: String = get_arg(&args, "imageHash", "image_hash")?;
            let is_main: bool = get_opt_arg(&args, "isMain", "is_main")?.unwrap_or(false);
            let now: String = get_arg(&args, "now", "now")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let row = repo::add_item_image(&conn, &state.data_dir, item_id, &bytes, &image_hash, is_main, &now)?;
            serde_json::to_value(row).map_err(|e| e.to_string())
        }
        "delete_item_image" => {
            let image_id: i64 = get_arg(&args, "imageId", "image_id")?;
            let now: String = get_arg(&args, "now", "now")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            repo::delete_item_image(&conn, &state.data_dir, image_id, &now)?;
            Ok(serde_json::Value::Null)
        }
        "set_item_image_main" => {
            let image_id: i64 = get_arg(&args, "imageId", "image_id")?;
            let now: String = get_arg(&args, "now", "now")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            repo::set_item_image_main(&conn, image_id, &now)?;
            Ok(serde_json::Value::Null)
        }
        "read_item_image" => {
            let image_id: i64 = get_arg(&args, "imageId", "image_id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let (bytes, _) = repo::read_item_image(&conn, &state.data_dir, image_id)?;
            serde_json::to_value(bytes).map_err(|e| e.to_string())
        }
        "save_held_bill" => {
            let bill: repo::HeldBillPayload = get_arg(&args, "bill", "bill")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let id = repo::save_held_bill(&conn, &bill)?;
            serde_json::to_value(id).map_err(|e| e.to_string())
        }
        "take_held_bill" => {
            let id: i64 = get_arg(&args, "id", "id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            repo::take_held_bill(&conn, id)?;
            Ok(serde_json::Value::Null)
        }
        "get_app_setting" => {
            let key: String = get_arg(&args, "key", "key")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let val = sync::get_setting(&conn, &key)?;
            serde_json::to_value(val).map_err(|e| e.to_string())
        }
        "set_app_setting" => {
            let key: String = get_arg(&args, "key", "key")?;
            let val: Option<String> = get_opt_arg(&args, "value", "value")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            state.auth.authorize_setting(&conn, &key, session)?;
            sync::set_setting(&conn, &key, val)?;
            Ok(serde_json::Value::Null)
        }
        "upsert_batch" => {
            let batch: repo::BatchPayload = get_arg(&args, "batch", "batch")?;
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            let id = repo::upsert_batch(&mut conn, &batch)?;
            serde_json::to_value(id).map_err(|e| e.to_string())
        }
        "list_batches_for_item" => {
            let item_id: i64 = get_arg(&args, "itemId", "item_id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let list = repo::list_batches_for_item(&conn, item_id)?;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "list_expiring_batches" => {
            let days_ahead: i64 = get_arg(&args, "daysThreshold", "days_threshold")?;
            let now_iso: String = get_arg(&args, "nowIso", "now_iso").unwrap_or_default();
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let list = repo::list_expiring_batches(&conn, days_ahead, &now_iso)?;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "update_customer_loyalty" => {
            let customer_id: i64 = get_arg(&args, "customerId", "customer_id")?;
            let points_delta: i64 = get_arg(&args, "pointsDelta", "points_delta")?;
            let bill_id: Option<i64> = get_opt_arg(&args, "billId", "bill_id")?;
            let reason: String = get_arg(&args, "reason", "reason")?;
            let created_at: String = get_arg(&args, "createdAt", "created_at")?;
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            let balance = repo::update_customer_loyalty(
                &mut conn,
                customer_id,
                points_delta,
                bill_id,
                &reason,
                &created_at,
            )?;
            serde_json::to_value(balance).map_err(|e| e.to_string())
        }
        "get_customer_loyalty_balance" => {
            let customer_id: i64 = get_arg(&args, "customerId", "customer_id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let bal = repo::get_customer_loyalty_balance(&conn, customer_id)?;
            serde_json::to_value(bal).map_err(|e| e.to_string())
        }
        "list_loyalty_transactions" => {
            let customer_id: i64 = get_arg(&args, "customerId", "customer_id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let list = repo::list_loyalty_transactions(&conn, customer_id)?;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "upsert_item_barcode" => {
            let item_id: i64 = get_arg(&args, "itemId", "item_id")?;
            let barcode: String = get_arg(&args, "barcode", "barcode")?;
            let pack_qty_milli: i64 = get_arg(&args, "packQtyMilli", "pack_qty_milli").unwrap_or(1000);
            let label: String = get_arg(&args, "label", "label").unwrap_or_default();
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let id = repo::upsert_item_barcode(&conn, item_id, &barcode, pack_qty_milli, &label)?;
            serde_json::to_value(id).map_err(|e| e.to_string())
        }
        "list_item_barcodes" => {
            let item_id: i64 = get_arg(&args, "itemId", "item_id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let list = repo::list_item_barcodes(&conn, item_id)?;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "delete_item_barcode" => {
            let barcode_id: i64 = get_arg(&args, "barcodeId", "barcode_id")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            repo::delete_item_barcode(&conn, barcode_id)?;
            Ok(serde_json::Value::Null)
        }
        "lookup_item_by_any_barcode" => {
            let barcode: String = get_arg(&args, "barcode", "barcode")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let res = repo::lookup_item_by_any_barcode(&conn, &barcode)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "create_day_end_closure" => {
            let closure: repo::DayEndClosurePayload = get_arg(&args, "closure", "closure")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let id = repo::create_day_end_closure(&conn, &closure)?;
            serde_json::to_value(id).map_err(|e| e.to_string())
        }
        "list_day_end_closures" => {
            let from_date: Option<String> = get_opt_arg(&args, "fromDate", "from_date")?;
            let to_date: Option<String> = get_opt_arg(&args, "toDate", "to_date")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let list =
                repo::list_day_end_closures(&conn, from_date.as_deref(), to_date.as_deref())?;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "get_day_end_expected_cash" => {
            let date_prefix: String = get_arg(&args, "datePrefix", "date_prefix")?;
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            let cash = repo::get_day_end_expected_cash(&conn, &date_prefix)?;
            serde_json::to_value(cash).map_err(|e| e.to_string())
        }
        other => Err(format!("unrecognized invoke command: {other}")),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn dev_api_override_only_accepts_loopback_hosts() {
        assert!(super::is_loopback_url("http://localhost:9000/api/v1/integrations"));
        assert!(super::is_loopback_url("http://127.0.0.1:9000"));
        assert!(!super::is_loopback_url("https://api.mytowncart.com"));
        assert!(!super::is_loopback_url("http://localhost@evil.example/"));
        assert!(!super::is_loopback_url("http://localhost.evil.example"));
        assert!(!super::is_loopback_url("ftp://localhost"));
    }

    use super::*;

    #[test]
    fn test_compute_server_urls() {
        let urls = compute_server_urls(9090, "abc");
        assert!(!urls.is_empty());
        assert!(urls.iter().any(|u| u == "http://localhost:9090/?key=abc"));
    }

    #[test]
    fn access_key_is_random_hex_and_compared_exactly() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert!(token_matches(&a, &a));
        assert!(!token_matches(&a, &b));
        assert!(!token_matches("", ""));
    }

    /// The browser client sends exactly the argument names the desktop commands use.
    #[test]
    fn lan_commands_accept_the_arguments_the_client_sends() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("t.db");
        crate::db::migrate(&db).unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        let state = AppState {
            data_dir: dir.path().to_path_buf(),
            db_path: db,
            conn: Arc::new(Mutex::new(conn)),
            restoring: Arc::new(AtomicBool::new(false)),
            auth: Arc::new(crate::auth::Auth::default()),
        };
        let audit = serde_json::json!({"auditLog": {"userId": null, "action": "x", "details": "", "createdAt": "2026-11-08T10:00:00Z"}});
        assert!(dispatch_invoke(&state, "record_audit_log", audit, None).is_ok());
        let exp = serde_json::json!({"daysThreshold": 30, "nowIso": "2026-11-08"});
        assert!(dispatch_invoke(&state, "list_expiring_batches", exp, None).is_ok());
    }

    #[test]
    fn sensitive_actions_are_audited_with_the_acting_user() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("t.db");
        crate::db::migrate(&db).unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        let owner = repo::upsert_user(
            &conn,
            &repo::UserPayload { id: None, name: "Owner".into(), role: "owner".into(), pin: "1111".into(), is_active: true, created_at: "x".into() },
        )
        .unwrap();
        let state = AppState {
            data_dir: dir.path().to_path_buf(),
            db_path: db,
            conn: Arc::new(Mutex::new(conn)),
            restoring: Arc::new(AtomicBool::new(false)),
            auth: Arc::new(crate::auth::Auth::default()),
        };
        let login = {
            let c = state.conn.lock().unwrap();
            crate::auth::login(&state.auth, &c, "1111", None).unwrap().unwrap()
        };
        let token = login["sessionToken"].as_str().unwrap().to_string();
        let user = serde_json::json!({"user": {"id": null, "name": "Priya", "role": "cashier", "pin": "2222", "isActive": true, "createdAt": "x"}});
        dispatch_invoke(&state, "upsert_user", user, Some(&token)).unwrap();
        let c = state.conn.lock().unwrap();
        let (uid, action, details): (i64, String, String) = c
            .query_row("SELECT user_id, action, details FROM audit_logs ORDER BY id DESC LIMIT 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!((uid, action.as_str()), (owner, "upsert_user"));
        assert!(details.contains("Priya") && !details.contains("2222"));
    }
}
