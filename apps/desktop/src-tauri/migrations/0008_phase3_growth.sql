-- SPDX-License-Identifier: Apache-2.0
-- Phase 3 Smart-Merchant Migration: Batches & Expiry, Loyalty, Multi-barcodes, Day-End Closures

-- Batches & Expiry tracking
CREATE TABLE item_batches (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id           INTEGER NOT NULL REFERENCES items(id),
  batch_no          TEXT NOT NULL,
  mfg_date          TEXT,
  expiry_date       TEXT NOT NULL,
  cost_price_paise  INTEGER NOT NULL DEFAULT 0,
  mrp_paise         INTEGER NOT NULL DEFAULT 0,
  stock_milli       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_batches_item ON item_batches(item_id);
CREATE INDEX idx_batches_expiry ON item_batches(expiry_date);

-- Customer Loyalty Points
ALTER TABLE customers ADD COLUMN loyalty_points INTEGER NOT NULL DEFAULT 0;

CREATE TABLE loyalty_transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  bill_id       INTEGER REFERENCES bills(id),
  points_delta  INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_loyalty_customer ON loyalty_transactions(customer_id);

-- Multiple Barcodes / Pack Sizes per Item
CREATE TABLE item_barcodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER NOT NULL REFERENCES items(id),
  barcode         TEXT NOT NULL UNIQUE,
  pack_qty_milli  INTEGER NOT NULL DEFAULT 1000,
  label           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_item_barcodes_barcode ON item_barcodes(barcode);
CREATE INDEX idx_item_barcodes_item ON item_barcodes(item_id);

-- Cash Drawer & Day-End (Z-Report) Closures
CREATE TABLE day_end_closures (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  closure_date          TEXT NOT NULL,
  user_id               INTEGER REFERENCES users(id),
  opening_cash_paise    INTEGER NOT NULL DEFAULT 0,
  cash_sales_paise      INTEGER NOT NULL DEFAULT 0,
  credit_received_paise INTEGER NOT NULL DEFAULT 0,
  cash_refunds_paise    INTEGER NOT NULL DEFAULT 0,
  expected_cash_paise   INTEGER NOT NULL DEFAULT 0,
  actual_cash_paise     INTEGER NOT NULL DEFAULT 0,
  variance_paise        INTEGER NOT NULL DEFAULT 0,
  total_bills_count     INTEGER NOT NULL DEFAULT 0,
  total_sales_paise     INTEGER NOT NULL DEFAULT 0,
  notes                 TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_day_end_date ON day_end_closures(closure_date);
