//! Durable per-item stock fences and recoverable reconciliation decisions.
#[cfg(test)]
#[path = "stock_protocol_tests.rs"]
mod tests;
use rusqlite::{params, Connection, TransactionBehavior};
use crate::repo::RepoResult;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StockProtocolState {
    pub external_id: String,
    pub variant_id: String,
    pub epoch: String,
    pub sequence: i64,
    pub revision: i64,
    pub generation: i64,
    pub stock_units: i64,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationInput {
    #[serde(flatten)] pub state: StockProtocolState,
    pub operation_id: String,
    pub item_id: i64,
    pub choice: String,
    pub expected_local_stock_milli: i64,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationIntent {
    #[serde(flatten)] pub input: ReconciliationInput,
    pub captured_stock_milli: i64,
    pub source_boundary: i64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub result: Option<StockProtocolState>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub review: Option<StockReview>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub parent_operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub reason: Option<String>,
    #[serde(default)] pub actor: Option<i64>,
    #[serde(default)] pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub approved_shortage_milli: Option<i64>,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockReview { pub current_stock_milli: i64, pub subsequent_delta_milli: i64, pub shortage_milli: i64 }
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInput { #[serde(flatten)] pub input: ReconciliationInput, pub parent_operation_id: String, pub reason: String }
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceResolutionInput {
    pub operation_id: String, pub source_id: i64, pub idempotency_key: String, pub raw_payload_json: String,
    pub action: String, pub item_id: Option<i64>, pub reason: String, pub confirmed: bool,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceResolution {
    #[serde(flatten)] pub input: SourceResolutionInput,
    pub actor: Option<i64>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub retired_by: Option<String>,
}
/// Database `pending` includes committed review parents and their linked leaves.
/// Source mappings fence stock changes until an explicitly captured settlement.
pub fn unresolved(conn: &Connection, external: Option<&str>) -> RepoResult<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM stock_reconciliations WHERE status='pending' AND (?1 IS NULL OR external_id=?1)) OR EXISTS(SELECT 1 FROM stock_source_resolutions WHERE external_id IS NOT NULL AND retired_by IS NULL AND (?1 IS NULL OR external_id=?1))",[external],|r|r.get(0)).map_err(|e|e.to_string())
}
fn valid(state: &StockProtocolState) -> RepoResult<()> {
    if state.external_id.is_empty() || state.epoch.is_empty() || state.variant_id.is_empty() || state.sequence < 0 || state.revision < 0 || state.generation < 0 || state.stock_units < 0 || state.stock_units.checked_mul(1000).is_none() { return Err("invalid stock protocol state".into()); }
    Ok(())
}
pub fn save_states(conn: &Connection, states: &[StockProtocolState]) -> RepoResult<()> {
    let tx = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    for state in states {
        valid(state)?;
        let pending = unresolved(&tx,Some(&state.external_id))?;
        if pending { return Err("stock reconciliation pending".into()); }
        // A snapshot alone is not a seller decision and cannot establish or
        // advance a suppression baseline. Only settlement may do that.
        let prior: String = tx.query_row("SELECT state_json FROM stock_protocol_states WHERE external_id=?1",[&state.external_id],|r|r.get(0)).map_err(|_|"stock baseline requires explicit reconciliation".to_string())?;
        let prior: StockProtocolState=serde_json::from_str(&prior).map_err(|e|e.to_string())?;
        if prior != *state { return Err("stock baseline changes require explicit reconciliation".into()); }
        tx.execute("INSERT INTO stock_protocol_states(external_id,state_json) VALUES (?1,?2) ON CONFLICT(external_id) DO UPDATE SET state_json=excluded.state_json", params![state.external_id, serde_json::to_string(state).map_err(|e|e.to_string())?]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e|e.to_string())
}
pub fn list_states(conn: &Connection) -> RepoResult<Vec<StockProtocolState>> {
    let mut stmt = conn.prepare("SELECT state_json FROM stock_protocol_states ORDER BY external_id").map_err(|e|e.to_string())?;
    let rows = stmt.query_map([], |r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;
    rows.map(|r|serde_json::from_str(&r.map_err(|e|e.to_string())?).map_err(|e|e.to_string())).collect()
}
pub fn activate(conn: &Connection, epoch: &str) -> RepoResult<()> {
    if epoch.is_empty() { return Err("stock epoch required".into()); }
    let tx=rusqlite::Transaction::new_unchecked(conn,TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let pending=unresolved(&tx,None)?;
    if pending { return Err("recover pending stock reconciliation before activation".into()); }
    let missing: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM items i WHERE i.remote_product_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM stock_protocol_states s WHERE (s.external_id=i.remote_product_id OR s.external_id=('itm_'||i.id)) AND json_extract(s.state_json,'$.epoch')=?1))",[epoch],|r|r.get(0)).map_err(|e|e.to_string())?;
    if missing { return Err("all linked items require a reconciled stock baseline".into()); }
    let previous=crate::sync::get_setting(&tx,"sync.stock_epoch")?;
    if previous.as_deref()!=Some(epoch) {
        crate::sync::set_cursor(&tx,"stock_cursor","0")?;
        // Internal protocol setting is the raw epoch consumed by the sync engine.
        tx.execute("INSERT INTO app_settings(key,value) VALUES ('sync.stock_epoch',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[epoch]).map_err(|e|e.to_string())?;
    }
    tx.execute("DELETE FROM app_settings WHERE key='sync.stock_bootstrap_required'",[]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())
}
pub fn begin(conn: &Connection, input: ReconciliationInput) -> RepoResult<ReconciliationIntent> {
    valid(&input.state)?;
    if input.operation_id.is_empty() || !["local","remote"].contains(&input.choice.as_str()) { return Err("invalid reconciliation input".into()); }
    let tx = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let prior = tx.query_row("SELECT request_json,intent_json FROM stock_reconciliations WHERE operation_id=?1", [&input.operation_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)));
    if let Ok((request,intent)) = prior {
        let original: ReconciliationInput = serde_json::from_str(&request).map_err(|e|e.to_string())?;
        if original != input { return Err("reconciliation operation key reused with changed payload".into()); }
        return serde_json::from_str(&intent).map_err(|e|e.to_string());
    }
    let stock: i64 = tx.query_row("SELECT stock_milli FROM items WHERE id=?1 AND (remote_product_id=?2 OR ('itm_'||id)=?2)", params![input.item_id,input.state.external_id], |r|r.get(0)).map_err(|e|format!("stock identity changed: {e}"))?;
    if stock != input.expected_local_stock_milli { return Err("local stock changed; refresh reconciliation".into()); }
    if input.choice == "local" && input.state.stock_units.checked_mul(1000) != Some(stock) { return Err("local reconciliation quantity differs from captured stock".into()); }
    let boundary: i64 = tx.query_row("SELECT COALESCE(MAX(id),0) FROM outbox", [], |r|r.get(0)).map_err(|e|e.to_string())?;
    let intent = ReconciliationIntent { input, captured_stock_milli: stock, source_boundary: boundary, status: "pending".into(), detail: None, result: None, review: None, parent_operation_id: None, reason: None, actor: None, created_at: timestamp(&tx)?, approved_shortage_milli: None };
    tx.execute("INSERT INTO stock_reconciliations(operation_id,external_id,item_id,request_json,intent_json,status) VALUES (?1,?2,?3,?4,?5,'pending')", params![intent.input.operation_id,intent.input.state.external_id,intent.input.item_id,serde_json::to_string(&intent.input).map_err(|e|e.to_string())?,serde_json::to_string(&intent).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    capture_sources(&tx, &intent)?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(intent)
}
fn capture_sources(conn: &Connection, intent: &ReconciliationIntent) -> RepoResult<()> {
    conn.execute("INSERT INTO stock_reconciliation_sources(operation_id,resolution_id) SELECT ?1,operation_id FROM stock_source_resolutions WHERE external_id=?2 AND source_id<=?3 AND retired_by IS NULL", params![intent.input.operation_id,intent.input.state.external_id,intent.source_boundary]).map_err(|e|e.to_string())?;
    Ok(())
}
fn timestamp(conn: &Connection) -> RepoResult<String> { conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",[],|r|r.get(0)).map_err(|e|e.to_string()) }
pub fn begin_recovery(conn: &Connection, recovery: RecoveryInput, actor: Option<i64>) -> RepoResult<ReconciliationIntent> {
    valid(&recovery.input.state)?;
    if recovery.reason.trim().is_empty() || recovery.input.operation_id.is_empty() || recovery.input.choice != "remote" || recovery.input.state.stock_units != 0 { return Err("recovery requires an explicit reason and zero target".into()); }
    let tx=rusqlite::Transaction::new_unchecked(conn,TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let prior=tx.query_row("SELECT intent_json,request_json FROM stock_reconciliations WHERE operation_id=?1",[&recovery.input.operation_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)));
    if let Ok((raw,request))=prior {
        let intent: ReconciliationIntent=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
        let original: ReconciliationInput=serde_json::from_str(&request).map_err(|e|e.to_string())?;
        if original!=recovery.input || intent.parent_operation_id.as_deref()!=Some(&recovery.parent_operation_id) || intent.reason.as_deref()!=Some(&recovery.reason) { return Err("reconciliation operation key reused with changed payload".into()); }
        return Ok(intent);
    }
    let raw: String=tx.query_row("SELECT intent_json FROM stock_reconciliations WHERE operation_id=?1 AND status='pending' AND active=1",[&recovery.parent_operation_id],|r|r.get(0)).map_err(|_|"review parent is not the active leaf".to_string())?;
    let parent: ReconciliationIntent=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
    if parent.status!="needs_review" || parent.input.item_id!=recovery.input.item_id || parent.input.state.external_id!=recovery.input.state.external_id { return Err("recovery parent mismatch".into()); }
    let committed=parent.result.ok_or("missing committed parent result")?;
    if recovery.input.state.variant_id!=committed.variant_id || recovery.input.state.epoch!=committed.epoch || recovery.input.state.generation<committed.generation || recovery.input.state.revision<committed.revision || recovery.input.state.sequence<committed.sequence { return Err("recovery requires fresh remote fences".into()); }
    let stock: i64=tx.query_row("SELECT stock_milli FROM items WHERE id=?1 AND (remote_product_id=?2 OR ('itm_'||id)=?2)",params![recovery.input.item_id,recovery.input.state.external_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if stock!=recovery.input.expected_local_stock_milli { return Err("local stock changed; refresh recovery".into()); }
    let parent_target=committed.stock_units.checked_mul(1000).and_then(|n|stock.checked_sub(parent.captured_stock_milli).and_then(|d|n.checked_add(d))).ok_or("stock rebase overflow")?;
    let approved_shortage_milli=Some(if parent_target<0 {parent_target.checked_neg().ok_or("stock rebase overflow")?} else {0});
    let boundary=tx.query_row("SELECT COALESCE(MAX(id),0) FROM outbox",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    tx.execute("UPDATE stock_reconciliations SET active=0 WHERE operation_id=?1",[&recovery.parent_operation_id]).map_err(|e|e.to_string())?;
    let intent=ReconciliationIntent {input:recovery.input,captured_stock_milli:stock,source_boundary:boundary,status:"pending".into(),detail:None,result:None,review:None,parent_operation_id:Some(recovery.parent_operation_id),reason:Some(recovery.reason),actor,created_at:timestamp(&tx)?,approved_shortage_milli};
    tx.execute("INSERT INTO stock_reconciliations(operation_id,external_id,item_id,request_json,intent_json,status,parent_operation_id) VALUES (?1,?2,?3,?4,?5,'pending',?6)",params![intent.input.operation_id,intent.input.state.external_id,intent.input.item_id,serde_json::to_string(&intent.input).map_err(|e|e.to_string())?,serde_json::to_string(&intent).map_err(|e|e.to_string())?,intent.parent_operation_id]).map_err(|e|e.to_string())?;
    capture_sources(&tx,&intent)?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(intent)
}
pub fn list(conn: &Connection) -> RepoResult<Vec<ReconciliationIntent>> {
    let mut stmt = conn.prepare("SELECT intent_json FROM stock_reconciliations ORDER BY rowid").map_err(|e|e.to_string())?;
    let rows = stmt.query_map([], |r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e|e.to_string())?).map_err(|e|e.to_string())).collect()
}
pub fn reject(conn: &Connection, operation: &str, detail: &str) -> RepoResult<()> {
    let tx=rusqlite::Transaction::new_unchecked(conn,TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let raw: String=tx.query_row("SELECT intent_json FROM stock_reconciliations WHERE operation_id=?1 AND status='pending'",[operation],|r|r.get(0)).map_err(|e|e.to_string())?;
    let mut intent: ReconciliationIntent=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
    if intent.status!="pending" || intent.result.is_some() { return Err("committed reconciliation cannot be rejected".into()); }
    intent.status="conflict".into(); intent.detail=Some(detail.into());
    tx.execute("UPDATE stock_reconciliations SET status='conflict',intent_json=?2 WHERE operation_id=?1",params![operation,serde_json::to_string(&intent).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    if let Some(parent)=&intent.parent_operation_id { tx.execute("UPDATE stock_reconciliations SET active=1 WHERE operation_id=?1",[parent]).map_err(|e|e.to_string())?; }
    tx.commit().map_err(|e|e.to_string())
}
pub fn settle(conn: &Connection, operation: &str, result: &StockProtocolState) -> RepoResult<ReconciliationIntent> {
    valid(result)?;
    let tx = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let (raw,status,prior): (String,String,Option<String>) = tx.query_row("SELECT intent_json,status,result_json FROM stock_reconciliations WHERE operation_id=?1", [operation], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;
    if let Some(prior)=prior {
        let previous: StockProtocolState=serde_json::from_str(&prior).map_err(|e|e.to_string())?;
        if previous!=*result { return Err("reconciliation result changed".into()); }
        return serde_json::from_str(&raw).map_err(|e|e.to_string());
    }
    if status != "pending" { return Err("reconciliation is not pending".into()); }
    let mut intent: ReconciliationIntent = serde_json::from_str(&raw).map_err(|e|e.to_string())?;
    if result.external_id != intent.input.state.external_id || result.variant_id != intent.input.state.variant_id || result.epoch != intent.input.state.epoch || result.sequence < intent.input.state.sequence || Some(result.generation) != intent.input.state.generation.checked_add(1) || result.revision <= intent.input.state.revision || result.stock_units != intent.input.state.stock_units { return Err("reconciliation result identity or fence mismatch".into()); }
    let current: i64 = tx.query_row("SELECT stock_milli FROM items WHERE id=?1 AND (remote_product_id=?2 OR ('itm_'||id)=?2)", params![intent.input.item_id,result.external_id], |r|r.get(0)).map_err(|e|format!("stock identity changed: {e}"))?;
    // Local movements after capture (including a LAN sale) survive the baseline.
    // Feed writes are blocked for this item while the intent is pending.
    let target = result.stock_units.checked_mul(1000).and_then(|n|current.checked_sub(intent.captured_stock_milli).and_then(|delta|n.checked_add(delta))).ok_or("stock rebase overflow")?;
    intent.result=Some(result.clone());
    if target < 0 {
        intent.status="needs_review".into();
        intent.detail=Some("Committed remote baseline cannot cover later local sales; explicit linked recovery required".into());
        intent.review=Some(StockReview {current_stock_milli:current,subsequent_delta_milli:current.checked_sub(intent.captured_stock_milli).ok_or("stock rebase overflow")?,shortage_milli:target.checked_neg().ok_or("stock rebase overflow")?});
        tx.execute("UPDATE stock_reconciliations SET intent_json=?2,result_json=?3 WHERE operation_id=?1",params![operation,serde_json::to_string(&intent).map_err(|e|e.to_string())?,serde_json::to_string(result).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())?;
        return Ok(intent);
    }
    let delta = target.checked_sub(current).ok_or("stock rebase overflow")?;
    let shortage = intent.approved_shortage_milli.unwrap_or(0);
    // Separate seller-confirmed shortage compensation from the baseline ledger
    // adjustment. Neither is a new delivery; their sum alone changes local stock.
    for (amount,reference) in [(delta.checked_sub(shortage).ok_or("stock rebase overflow")?,operation.to_string()),(shortage,format!("{operation}:shortage"))] {
        if amount!=0 { tx.execute("INSERT INTO stock_movements(item_id,delta_milli,reason,ref_type,ref_id,created_at) VALUES (?1,?2,'adjustment','reconcile',?3,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",params![intent.input.item_id,amount,reference]).map_err(|e|e.to_string())?; }
    }
    tx.execute("UPDATE items SET stock_milli=?2 WHERE id=?1", params![intent.input.item_id,target]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE outbox SET status='done',next_attempt_at=NULL,quarantine_reason=NULL WHERE id<=?1 AND status IN ('pending','quarantined') AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.externalId')=?2 ELSE 0 END", params![intent.source_boundary,result.external_id]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE stock_deliveries SET status='done',claim_token=NULL,claim_until=NULL,next_attempt_at=NULL WHERE outbox_id IN (SELECT id FROM outbox WHERE id<=?1 AND status='done') AND external_id=?2",params![intent.source_boundary,result.external_id]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO stock_protocol_states(external_id,state_json) VALUES (?1,?2) ON CONFLICT(external_id) DO UPDATE SET state_json=excluded.state_json",params![result.external_id,serde_json::to_string(result).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE stock_source_resolutions SET retired_by=?1 WHERE operation_id IN (SELECT resolution_id FROM stock_reconciliation_sources WHERE operation_id=?1) AND retired_by IS NULL",[operation]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE outbox SET status='done',next_attempt_at=NULL WHERE id IN (SELECT source_id FROM stock_source_resolutions WHERE retired_by=?1)",[operation]).map_err(|e|e.to_string())?;
    intent.status="done".into();
    tx.execute("UPDATE stock_reconciliations SET status='done',intent_json=?2,result_json=?3 WHERE operation_id=?1",params![operation,serde_json::to_string(&intent).map_err(|e|e.to_string())?,serde_json::to_string(result).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    let mut parent=intent.parent_operation_id.clone();
    while let Some(id)=parent {
        let raw: String=tx.query_row("SELECT intent_json FROM stock_reconciliations WHERE operation_id=?1",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
        let mut ancestor: ReconciliationIntent=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
        ancestor.status="done".into();
        parent=ancestor.parent_operation_id.clone();
        tx.execute("UPDATE stock_reconciliations SET status='done',intent_json=?2 WHERE operation_id=?1",params![id,serde_json::to_string(&ancestor).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e|e.to_string())?;
    Ok(intent)
}

pub fn resolve_source(conn: &Connection, input: SourceResolutionInput, actor: Option<i64>) -> RepoResult<SourceResolution> {
    if input.operation_id.trim().is_empty() || input.reason.trim().is_empty() || !input.confirmed || !["map","historical_unknown"].contains(&input.action.as_str()) { return Err("explicit reason and confirmation required".into()); }
    let tx=rusqlite::Transaction::new_unchecked(conn,TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let prior=tx.query_row("SELECT request_json,evidence_json,retired_by FROM stock_source_resolutions WHERE operation_id=?1",[&input.operation_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?)));
    if let Ok((request,evidence,retired))=prior {
        let original: SourceResolutionInput=serde_json::from_str(&request).map_err(|e|e.to_string())?;
        if original!=input { return Err("source resolution operation key reused with changed payload".into()); }
        let mut resolution: SourceResolution=serde_json::from_str(&evidence).map_err(|e|e.to_string())?;
        resolution.retired_by=retired;
        return Ok(resolution);
    }
    let (key,payload,status):(String,String,String)=tx.query_row("SELECT idempotency_key,payload_json,status FROM outbox WHERE id=?1",[input.source_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;
    if key!=input.idempotency_key || payload!=input.raw_payload_json || status!="quarantined" { return Err("source evidence changed or is not quarantined".into()); }
    let has_delivery: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM stock_deliveries WHERE outbox_id=?1)",[input.source_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if has_delivery { return Err("delivery evidence requires ordinary stock reconciliation".into()); }
    // Only malformed, unidentifiable artifacts use this exceptional path.
    let identifiable=serde_json::from_str::<serde_json::Value>(&payload).ok().and_then(|v|v.get("externalId").and_then(|x|x.as_str()).map(|s|!s.is_empty())).unwrap_or(false);
    if identifiable { return Err("identified sources require ordinary stock reconciliation".into()); }
    let external_id=if input.action=="map" {
        let id=input.item_id.ok_or("mapping requires a linked item")?;
        let external: String=tx.query_row("SELECT 'itm_'||id FROM items WHERE id=?1 AND remote_product_id IS NOT NULL AND remote_product_id!=''",[id],|r|r.get(0)).map_err(|_|"mapping requires a verified linked item".to_string())?;
        Some(external)
    } else { if input.item_id.is_some() { return Err("historical unknown disposition cannot select an item".into()); } None };
    let resolution=SourceResolution {input,actor,external_id,retired_by:None,created_at:timestamp(&tx)?};
    tx.execute("INSERT INTO stock_source_resolutions(operation_id,source_id,request_json,evidence_json,external_id) VALUES (?1,?2,?3,?4,?5)",params![resolution.input.operation_id,resolution.input.source_id,serde_json::to_string(&resolution.input).map_err(|e|e.to_string())?,serde_json::to_string(&resolution).map_err(|e|e.to_string())?,resolution.external_id]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(resolution)
}
pub fn list_source_resolutions(conn: &Connection) -> RepoResult<Vec<SourceResolution>> {
    let mut stmt=conn.prepare("SELECT evidence_json,retired_by FROM stock_source_resolutions ORDER BY rowid").map_err(|e|e.to_string())?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).map_err(|e|e.to_string())?;
    rows.map(|r| {let (raw,retired)=r.map_err(|e|e.to_string())?;let mut v:SourceResolution=serde_json::from_str(&raw).map_err(|e|e.to_string())?;v.retired_by=retired;Ok(v)}).collect()
}
