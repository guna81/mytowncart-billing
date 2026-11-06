-- SPDX-License-Identifier: Apache-2.0
-- Phase 2 Daily-Driver Migration: Credit notes, Suppliers & Purchases, Users & Audit

-- Credit Notes (returns)
CREATE TABLE credit_notes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id         INTEGER NOT NULL REFERENCES bills(id),
  number          TEXT NOT NULL UNIQUE,
  fy              TEXT NOT NULL,
  reason          TEXT NOT NULL,
  subtotal_paise  INTEGER NOT NULL,
  tax_paise       INTEGER NOT NULL,
  total_paise     INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_credit_notes_bill ON credit_notes(bill_id);
CREATE INDEX idx_credit_notes_created ON credit_notes(created_at);

CREATE TABLE credit_note_lines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_note_id    INTEGER NOT NULL REFERENCES credit_notes(id),
  item_id           INTEGER REFERENCES items(id),
  name_snapshot     TEXT NOT NULL,
  qty_milli         INTEGER NOT NULL,
  unit_price_paise  INTEGER NOT NULL,
  tax_rate_bp       INTEGER NOT NULL,
  tax_paise         INTEGER NOT NULL,
  total_paise       INTEGER NOT NULL,
  hsn_code          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_credit_note_lines_cn ON credit_note_lines(credit_note_id);

-- Suppliers
CREATE TABLE suppliers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  gstin       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_suppliers_name ON suppliers(name);

-- Purchases
CREATE TABLE purchases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id     INTEGER NOT NULL REFERENCES suppliers(id),
  invoice_no      TEXT NOT NULL,
  invoice_date    TEXT NOT NULL,
  subtotal_paise  INTEGER NOT NULL,
  tax_paise       INTEGER NOT NULL,
  total_paise     INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'received',
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX idx_purchases_date ON purchases(invoice_date);

CREATE TABLE purchase_lines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id       INTEGER NOT NULL REFERENCES purchases(id),
  item_id           INTEGER REFERENCES items(id),
  name_snapshot     TEXT NOT NULL,
  qty_milli         INTEGER NOT NULL,
  unit_cost_paise   INTEGER NOT NULL,
  tax_rate_bp       INTEGER NOT NULL,
  tax_paise         INTEGER NOT NULL,
  total_paise       INTEGER NOT NULL
);
CREATE INDEX idx_purchase_lines_purchase ON purchase_lines(purchase_id);

-- Users & Roles
CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'cashier',
  pin         TEXT NOT NULL DEFAULT '',
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

-- Audit logs
CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
