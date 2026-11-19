use super::*;
use crate::{db, sync};
fn setup() -> (tempfile::TempDir, Connection) {
    let dir=tempfile::tempdir().unwrap();
    let path=dir.path().join("stock.db");
    db::migrate_with(&path,db::MIGRATIONS).unwrap();
    let conn=db::open(&path).unwrap();
    conn.execute_batch("INSERT INTO items(id,name,stock_milli,remote_product_id,updated_at) VALUES(1,'First',5000,'itm_1','now'),(2,'Second',5000,'itm_2','now');
        INSERT INTO stock_movements(item_id,delta_milli,reason,created_at) VALUES(1,5000,'opening','now'),(2,5000,'opening','now');").unwrap();
    (dir,conn)
}
fn state(id:i64,quantity:i64) -> StockProtocolState { StockProtocolState {external_id:format!("itm_{id}"),variant_id:format!("variant-{id}"),epoch:"epoch-a".into(),sequence:10,revision:3,generation:2,stock_units:quantity} }
fn input(id:i64,quantity:i64) -> ReconciliationInput { ReconciliationInput {state:state(id,quantity),operation_id:format!("op-{id}"),item_id:id,choice:"remote".into(),expected_local_stock_milli:5000} }
fn result(id:i64,quantity:i64) -> StockProtocolState { StockProtocolState{generation:3,revision:4,sequence:12,..state(id,quantity)} }
fn enqueue(conn:&Connection,id:i64,delta:i64,key:&str) {
    sync::enqueue_stock_outbox(conn,&[(serde_json::json!({"externalId":format!("itm_{id}"),"deltaUnits":delta,"reason":if delta<0 {"sale"} else {"order_cancel"},"createdAt":"2026-01-01T00:00:00Z"}).to_string(),key.into())]).unwrap();
}
#[test]
fn reconciliation_restarts_rebases_lan_sale_and_suppresses_only_selected_item() {
    let (dir,conn)=setup(); enqueue(&conn,1,-1,"old");
    let request=input(1,7); let intent=begin(&conn,request.clone()).unwrap();
    assert_eq!(intent.source_boundary,1);
    assert!(sync::claim_stock_delivery(&conn,"2026-01-01T00:00:00Z","2026-01-01T00:01:00Z").unwrap().is_none());
    let lan=db::open(&dir.path().join("stock.db")).unwrap();
    lan.execute("UPDATE items SET stock_milli=stock_milli-1000 WHERE id=1",[]).unwrap();
    lan.execute("INSERT INTO stock_movements(item_id,delta_milli,reason,created_at) VALUES(1,-1000,'sale','now')",[]).unwrap();
    enqueue(&lan,1,-1,"later-sale"); drop(conn);
    let mut conn=db::open(&dir.path().join("stock.db")).unwrap();
    assert_eq!(begin(&conn,request.clone()).unwrap().source_boundary,1);
    let mut changed=request; changed.state.stock_units=8; assert!(begin(&conn,changed).is_err());
    settle(&conn,"op-1",&result(1,7)).unwrap(); settle(&conn,"op-1",&result(1,7)).unwrap();
    let stock:i64=conn.query_row("SELECT stock_milli FROM items WHERE id=1",[],|r|r.get(0)).unwrap(); assert_eq!(stock,6000);
    assert_eq!(sync::list_outbox(&conn,Some("pending")).unwrap().len(),1);
    let moves=[sync::RemoteStockMovePayload{external_id:"itm_1".into(),delta_units:-2,reason:"online_order".into(),created_at:"now".into(),epoch:Some("epoch-a".into()),sequence:Some(11)},sync::RemoteStockMovePayload{external_id:"itm_2".into(),delta_units:-1,reason:"online_order".into(),created_at:"now".into(),epoch:Some("epoch-a".into()),sequence:Some(12)}];
    let applied=sync::apply_stock_pull(&mut conn,None,"12",&moves).unwrap(); assert_eq!(applied.len(),1); assert_eq!(applied[0].external_id,"itm_2");
    assert_eq!(sync::get_cursor(&conn,"stock_cursor").unwrap().as_deref(),Some("12"));
    let claim=sync::claim_stock_delivery(&conn,"2026-01-01T00:02:00Z","2026-01-01T00:03:00Z").unwrap().unwrap();
    let payload:serde_json::Value=serde_json::from_str(&claim.payload_json).unwrap(); assert_eq!(payload["generation"],3); assert_eq!(payload["variantId"],"variant-1");
}
#[test]
fn stale_capture_conflicting_intent_and_invalid_result_leave_everything_unchanged() {
    let (_dir,conn)=setup(); let mut stale=input(1,4); stale.expected_local_stock_milli=4000; assert!(begin(&conn,stale).is_err());
    begin(&conn,input(1,4)).unwrap(); let mut duplicate=input(1,4); duplicate.operation_id="other".into(); assert!(begin(&conn,duplicate).is_err());
    assert!(settle(&conn,"op-1",&result(1,5)).is_err());
    let mut bad=result(1,4); bad.generation=2; assert!(settle(&conn,"op-1",&bad).is_err());
    conn.execute("UPDATE items SET stock_milli=0 WHERE id=1",[]).unwrap();
    assert_eq!(settle(&conn,"op-1",&result(1,4)).unwrap().status,"needs_review");
    assert_eq!(list(&conn).unwrap()[0].status,"needs_review"); assert!(list_states(&conn).unwrap().is_empty());
    assert!(reject(&conn,"op-1","remote revision conflict").is_err());
    assert_eq!(settle(&conn,"op-1",&result(1,4)).unwrap().status,"needs_review");
    begin(&conn,input(2,5)).unwrap(); reject(&conn,"op-2","conflict").unwrap();
    assert!(settle(&conn,"op-2",&result(2,5)).is_err());
}
#[test]
fn epoch_activation_requires_all_items_and_does_not_reset_same_epoch_cursor() {
    let (_dir,conn)=setup();
    assert!(save_states(&conn,&[state(1,5)]).is_err());
    begin(&conn,input(1,5)).unwrap();settle(&conn,"op-1",&result(1,5)).unwrap();
    assert!(activate(&conn,"epoch-a").is_err());
    begin(&conn,input(2,5)).unwrap();settle(&conn,"op-2",&result(2,5)).unwrap();
    activate(&conn,"epoch-a").unwrap(); assert_eq!(sync::get_setting(&conn,"sync.stock_epoch").unwrap().as_deref(),Some("epoch-a"));
    sync::set_cursor(&conn,"stock_cursor","99").unwrap(); activate(&conn,"epoch-a").unwrap();assert_eq!(sync::get_cursor(&conn,"stock_cursor").unwrap().as_deref(),Some("99"));
}
#[test]
fn ordered_sale_void_retry_claims_and_quarantine_allow_other_item_progress() {
    let (_dir,conn)=setup(); enqueue(&conn,1,-1,"sale"); enqueue(&conn,1,1,"void"); enqueue(&conn,2,-1,"other");
    let a=sync::claim_stock_delivery(&conn,"2026-01-01T00:00:00Z","2026-01-01T00:01:00Z").unwrap().unwrap();
    sync::settle_stock_delivery(&conn,a.id,&a.claim_token,"retry",Some("2026-01-01T00:03:00Z"),None).unwrap();
    let other=sync::claim_stock_delivery(&conn,"2026-01-01T00:01:00Z","2026-01-01T00:02:00Z").unwrap().unwrap(); assert!(other.payload_json.contains("itm_2"));
    sync::settle_stock_delivery(&conn,other.id,&other.claim_token,"done",None,None).unwrap();
    let retry=sync::claim_stock_delivery(&conn,"2026-01-01T00:03:00Z","2026-01-01T00:04:00Z").unwrap().unwrap();assert_eq!(retry.payload_json,a.payload_json);
    sync::settle_stock_delivery(&conn,retry.id,&retry.claim_token,"quarantined",None,Some("clamped")).unwrap();
    assert!(sync::claim_stock_delivery(&conn,"2026-01-01T00:05:00Z","2026-01-01T00:06:00Z").unwrap().is_none());
    assert_eq!(sync::list_outbox(&conn,Some("quarantined")).unwrap().len(),1);
}
fn recovery(operation: &str, parent: &str, stock: i64, fence: StockProtocolState) -> RecoveryInput {
    RecoveryInput {input: ReconciliationInput {state: StockProtocolState {stock_units:0,..fence},operation_id:operation.into(),item_id:1,choice:"remote".into(),expected_local_stock_milli:stock},parent_operation_id:parent.into(),reason:"Seller confirms zero; shortage reviewed".into()}
}
fn committed(input: &ReconciliationInput) -> StockProtocolState { StockProtocolState {generation:input.state.generation+1,revision:input.state.revision+1,sequence:input.state.sequence+1,..input.state.clone()} }
#[test]
fn linked_zero_recovery_restarts_repeats_shortage_and_finalizes_chain_without_outbox() {
    let (dir,conn)=setup(); enqueue(&conn,1,-1,"prior");
    begin(&conn,input(1,1)).unwrap();
    conn.execute("UPDATE items SET stock_milli=3000 WHERE id=1",[]).unwrap(); enqueue(&conn,1,-2,"later");
    let parent=settle(&conn,"op-1",&result(1,1)).unwrap();
    assert_eq!(parent.review.as_ref().unwrap().shortage_milli,1000);
    assert!(settle(&conn,"op-1",&result(1,2)).is_err());
    assert!(activate(&conn,"epoch-a").is_err());
    assert!(sync::claim_stock_delivery(&conn,"2026-01-01T00:00:00Z","2026-01-01T00:01:00Z").unwrap().is_none());
    let mut stale=recovery("child","op-1",4000,result(1,1)); assert!(begin_recovery(&conn,stale.clone(),Some(7)).is_err());
    stale.input.expected_local_stock_milli=3000;
    let child=begin_recovery(&conn,stale.clone(),Some(7)).unwrap(); assert_eq!(child.source_boundary,2);
    assert_eq!(begin_recovery(&conn,stale.clone(),Some(8)).unwrap().actor,Some(7));
    let mut changed=stale.clone();changed.reason="changed".into();assert!(begin_recovery(&conn,changed,None).is_err());
    let lan=db::open(&dir.path().join("stock.db")).unwrap();lan.execute("UPDATE items SET stock_milli=2000 WHERE id=1",[]).unwrap();enqueue(&lan,1,-1,"post-child");
    let child_result=committed(&stale.input); assert_eq!(settle(&conn,"child",&child_result).unwrap().status,"needs_review");
    drop(conn); let conn=db::open(&dir.path().join("stock.db")).unwrap();
    let request=recovery("grandchild","child",2000,child_result.clone());
    begin_recovery(&conn,request.clone(),Some(7)).unwrap();
    // A post-capture return survives; it is not swallowed by the child boundary.
    conn.execute("UPDATE items SET stock_milli=3000 WHERE id=1",[]).unwrap();enqueue(&conn,1,1,"post-grandchild-return");
    let result=committed(&request.input);settle(&conn,"grandchild",&result).unwrap();settle(&conn,"grandchild",&result).unwrap();
    assert!(list(&conn).unwrap().iter().all(|i|i.status=="done"));
    let original=list(&conn).unwrap().remove(0);assert_eq!(original.result,parent.result);assert_eq!(original.input,parent.input);
    assert_eq!(conn.query_row("SELECT stock_milli FROM items WHERE id=1",[],|r|r.get::<_,i64>(0)).unwrap(),1000);
    let pending=sync::list_outbox(&conn,Some("pending")).unwrap();assert_eq!(pending.len(),1);assert_eq!(pending[0].idempotency_key,"post-grandchild-return");
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM stock_movements WHERE ref_id='grandchild:shortage'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}
#[test]
fn failed_child_settlement_rolls_back_chain_baseline_sources_and_ledger() {
    let (_dir,conn)=setup();begin(&conn,input(1,0)).unwrap();conn.execute("UPDATE items SET stock_milli=4000 WHERE id=1",[]).unwrap();settle(&conn,"op-1",&result(1,0)).unwrap();enqueue(&conn,1,-1,"captured");
    let request=recovery("child","op-1",4000,result(1,0));begin_recovery(&conn,request.clone(),None).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_baseline BEFORE INSERT ON stock_protocol_states BEGIN SELECT RAISE(ABORT,'injected baseline failure'); END;").unwrap();
    assert!(settle(&conn,"child",&committed(&request.input)).is_err());
    assert_eq!(list(&conn).unwrap().iter().map(|i|i.status.as_str()).collect::<Vec<_>>(),vec!["needs_review","pending"]);
    assert_eq!(sync::list_outbox(&conn,Some("pending")).unwrap().len(),1);
    assert_eq!(conn.query_row("SELECT stock_milli FROM items WHERE id=1",[],|r|r.get::<_,i64>(0)).unwrap(),4000);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM stock_movements WHERE ref_type='reconcile'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    conn.execute_batch("DROP TRIGGER fail_baseline").unwrap();settle(&conn,"child",&committed(&request.input)).unwrap();
    assert!(list(&conn).unwrap().iter().all(|i|i.status=="done"));
}
#[test]
fn simultaneous_recovery_capture_has_one_winner() {
    let (dir,conn)=setup();begin(&conn,input(1,0)).unwrap();conn.execute("UPDATE items SET stock_milli=4000 WHERE id=1",[]).unwrap();settle(&conn,"op-1",&result(1,0)).unwrap();
    let barrier=std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_>=(0..2).map(|n| {let path=dir.path().join("stock.db");let barrier=barrier.clone();std::thread::spawn(move || {let conn=db::open(&path).unwrap();conn.busy_timeout(std::time::Duration::from_secs(5)).unwrap();barrier.wait();begin_recovery(&conn,recovery(&format!("concurrent-{n}"),"op-1",4000,result(1,0)),None).is_ok()})}).collect();
    assert_eq!(handles.into_iter().map(|h|usize::from(h.join().unwrap())).sum::<usize>(),1);
    assert_eq!(list(&conn).unwrap().len(),2);
}
#[test]
fn child_shortage_is_captured_from_current_stock_not_stale_review() {
    let (_dir,conn)=setup();begin(&conn,input(1,1)).unwrap();conn.execute("UPDATE items SET stock_milli=3000 WHERE id=1",[]).unwrap();
    assert_eq!(settle(&conn,"op-1",&result(1,1)).unwrap().review.unwrap().shortage_milli,1000);
    conn.execute("UPDATE items SET stock_milli=2000 WHERE id=1",[]).unwrap();
    let request=recovery("child","op-1",2000,result(1,1));
    assert_eq!(begin_recovery(&conn,request.clone(),None).unwrap().approved_shortage_milli,Some(2000));
    settle(&conn,"child",&committed(&request.input)).unwrap();
    assert_eq!(conn.query_row("SELECT delta_milli FROM stock_movements WHERE ref_id='child:shortage'",[],|r|r.get::<_,i64>(0)).unwrap(),2000);
}
#[test]
fn competing_recovery_connections_share_single_leaf_and_conflict_restores_parent() {
    let (dir,conn)=setup();begin(&conn,input(1,0)).unwrap();conn.execute("UPDATE items SET stock_milli=4000 WHERE id=1",[]).unwrap();settle(&conn,"op-1",&result(1,0)).unwrap();
    let other=db::open(&dir.path().join("stock.db")).unwrap();let a=recovery("a","op-1",4000,result(1,0));let b=recovery("b","op-1",4000,result(1,0));
    begin_recovery(&conn,a,None).unwrap();assert!(begin_recovery(&other,b.clone(),None).is_err());
    reject(&conn,"a","stale remote generation").unwrap();assert!(settle(&conn,"a",&result(1,0)).is_err());
    begin_recovery(&other,b,None).unwrap();
}

