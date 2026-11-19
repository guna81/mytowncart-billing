-- Review parents remain pending database fences; only the active leaf owns exclusivity.
ALTER TABLE stock_reconciliations ADD COLUMN parent_operation_id TEXT REFERENCES stock_reconciliations(operation_id);
ALTER TABLE stock_reconciliations ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1));
DROP INDEX stock_reconciliations_pending_item;
CREATE UNIQUE INDEX stock_reconciliations_pending_item ON stock_reconciliations(external_id) WHERE status='pending' AND active=1;
CREATE UNIQUE INDEX stock_reconciliations_child ON stock_reconciliations(parent_operation_id) WHERE status!='conflict';
CREATE TRIGGER stock_reconciliation_request_immutable BEFORE UPDATE OF request_json,parent_operation_id,external_id,item_id ON stock_reconciliations BEGIN SELECT RAISE(ABORT,'reconciliation request is immutable'); END;
CREATE TRIGGER stock_reconciliation_result_immutable BEFORE UPDATE OF result_json ON stock_reconciliations WHEN OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json BEGIN SELECT RAISE(ABORT,'committed reconciliation result is immutable'); END;
