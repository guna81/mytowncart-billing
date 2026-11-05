-- SPDX-License-Identifier: Apache-2.0
-- 0002_schema — B1: full local schema (roadmap §8.3).
-- Forward-only: never edit an applied migration; add a new numbered file.
-- outbox + sync_state are created now but stay UNUSED until B5 (stock sync).

CREATE TABLE shop_profile (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  name                     TEXT NOT NULL,
  gst_enabled              INTEGER NOT NULL DEFAULT 0,
  prices_include_tax       INTEGER NOT NULL DEFAULT 1,
  invoice_prefix           TEXT NOT NULL DEFAULT 'INV-',
  address                  TEXT NOT NULL DEFAULT '',
  phone                    TEXT NOT NULL DEFAULT '',
  gstin                    TEXT NOT NULL DEFAULT '',
  receipt_footer           TEXT NOT NULL DEFAULT '',
  low_stock_threshold_milli INTEGER NOT NULL DEFAULT 0,
  updated_at               TEXT NOT NULL
);

CREATE TABLE categories (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT NOT NULL UNIQUE,
  marketplace_category_id INTEGER
);

CREATE TABLE items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  barcode            TEXT NOT NULL DEFAULT '',
  category_id        INTEGER REFERENCES categories(id),
  unit_kind          TEXT NOT NULL DEFAULT 'count'
                     CHECK (unit_kind IN ('count', 'weight', 'volume')),
  price_paise        INTEGER NOT NULL DEFAULT 0,
  mrp_paise          INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp        INTEGER NOT NULL DEFAULT 0,
  stock_milli        INTEGER NOT NULL DEFAULT 0,
  is_active          INTEGER NOT NULL DEFAULT 1,
  photo_path         TEXT NOT NULL DEFAULT '',
  publish_state      TEXT NOT NULL DEFAULT 'local_only',
  remote_product_id  INTEGER,
  remote_variant_id  INTEGER,
  content_hash       TEXT,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_items_barcode ON items (barcode);
CREATE INDEX idx_items_name ON items (name);

CREATE TABLE customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customers_phone ON customers (phone);

CREATE TABLE bills (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         TEXT NOT NULL,
  fy             TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  customer_id    INTEGER REFERENCES customers(id),
  subtotal_paise INTEGER NOT NULL,
  tax_paise      INTEGER NOT NULL,
  total_paise    INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  voided_at      TEXT,
  void_reason    TEXT,
  -- Sequences restart each FY, so uniqueness is per (fy, number). A shop that
  -- wants globally unique display numbers embeds the FY in its prefix.
  UNIQUE (fy, number)
);
CREATE INDEX idx_bills_created_at ON bills (created_at);
CREATE INDEX idx_bills_fy ON bills (fy);

CREATE TABLE bill_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id          INTEGER NOT NULL REFERENCES bills(id),
  line_no          INTEGER NOT NULL,
  item_id          INTEGER REFERENCES items(id),
  name_snapshot    TEXT NOT NULL,
  qty_milli        INTEGER NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  tax_rate_bp      INTEGER NOT NULL,
  tax_paise        INTEGER NOT NULL,
  total_paise      INTEGER NOT NULL
);
CREATE INDEX idx_bill_lines_bill ON bill_lines (bill_id);
CREATE INDEX idx_bill_lines_item ON bill_lines (item_id);

CREATE TABLE payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id      INTEGER NOT NULL REFERENCES bills(id),
  mode         TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'card', 'credit')),
  amount_paise INTEGER NOT NULL
);
CREATE INDEX idx_payments_bill ON payments (bill_id);

CREATE TABLE stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  delta_milli INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  ref_type    TEXT,
  ref_id      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_stock_movements_item ON stock_movements (item_id);

-- Invoice number allocation: one row per (financial year, prefix); the
-- next_no counter is read and incremented inside the bill-save transaction
-- (BEGIN IMMEDIATE) so numbers are gap-free per FY.
CREATE TABLE invoice_counters (
  fy      TEXT NOT NULL,
  prefix  TEXT NOT NULL,
  next_no INTEGER NOT NULL,
  PRIMARY KEY (fy, prefix)
);

-- B5 (stock sync) — created now, unused until then.
CREATE TABLE outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
);

-- B5 (stock sync cursors) — created now, unused until then.
CREATE TABLE sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
