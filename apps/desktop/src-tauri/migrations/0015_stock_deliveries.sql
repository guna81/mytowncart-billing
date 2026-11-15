-- Pre-upgrade requests may already have committed under an unknown retry key.
UPDATE outbox SET status = 'quarantined' WHERE status = 'pending';
ALTER TABLE outbox ADD COLUMN quarantine_reason TEXT;
UPDATE outbox SET quarantine_reason = 'Pre-upgrade stock outcome unknown; explicit reconciliation required' WHERE status = 'quarantined';
CREATE TABLE stock_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER NOT NULL UNIQUE REFERENCES outbox(id),
  external_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'done', 'quarantined')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  claim_token TEXT,
  claim_until TEXT,
  outcome_detail TEXT
);
CREATE INDEX stock_deliveries_item_order ON stock_deliveries(external_id, id);
CREATE TABLE stock_protocol_states (
  external_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL
);
CREATE TABLE stock_reconciliations (
  operation_id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id),
  request_json TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','done','conflict')),
  result_json TEXT
);
CREATE UNIQUE INDEX stock_reconciliations_pending_item ON stock_reconciliations(external_id) WHERE status = 'pending';
