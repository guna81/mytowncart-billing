-- Review parents remain pending database fences; only the active leaf owns exclusivity.
ALTER TABLE stock_reconciliations ADD COLUMN parent_operation_id TEXT REFERENCES stock_reconciliations(operation_id);
ALTER TABLE stock_reconciliations ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1));
DROP INDEX stock_reconciliations_pending_item;
CREATE UNIQUE INDEX stock_reconciliations_pending_item ON stock_reconciliations(external_id) WHERE status='pending' AND active=1;
CREATE UNIQUE INDEX stock_reconciliations_child ON stock_reconciliations(parent_operation_id) WHERE status!='conflict';
CREATE TABLE stock_source_resolutions (
 operation_id TEXT PRIMARY KEY,
 source_id INTEGER NOT NULL UNIQUE REFERENCES outbox(id),
 request_json TEXT NOT NULL,
 evidence_json TEXT NOT NULL,
 external_id TEXT,
 retired_by TEXT REFERENCES stock_reconciliations(operation_id)
);
CREATE TABLE stock_reconciliation_sources (
 operation_id TEXT NOT NULL REFERENCES stock_reconciliations(operation_id),
 resolution_id TEXT NOT NULL REFERENCES stock_source_resolutions(operation_id),
 PRIMARY KEY(operation_id,resolution_id)
);
CREATE TRIGGER stock_source_evidence_immutable BEFORE UPDATE OF operation_id,source_id,request_json,evidence_json,external_id ON stock_source_resolutions BEGIN SELECT RAISE(ABORT,'stock source evidence is immutable'); END;
CREATE TRIGGER stock_source_evidence_retained BEFORE DELETE ON stock_source_resolutions BEGIN SELECT RAISE(ABORT,'stock source evidence must be retained'); END;
CREATE TRIGGER stock_resolved_source_raw_immutable BEFORE UPDATE OF payload_json,idempotency_key ON outbox WHEN EXISTS(SELECT 1 FROM stock_source_resolutions WHERE source_id=OLD.id) BEGIN SELECT RAISE(ABORT,'resolved source raw evidence is immutable'); END;
CREATE TRIGGER stock_reconciliation_request_immutable BEFORE UPDATE OF request_json,parent_operation_id,external_id,item_id ON stock_reconciliations BEGIN SELECT RAISE(ABORT,'reconciliation request is immutable'); END;
CREATE TRIGGER stock_reconciliation_result_immutable BEFORE UPDATE OF result_json ON stock_reconciliations WHEN OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json BEGIN SELECT RAISE(ABORT,'committed reconciliation result is immutable'); END;
