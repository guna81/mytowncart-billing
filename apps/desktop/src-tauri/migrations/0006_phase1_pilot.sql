-- SPDX-License-Identifier: Apache-2.0
-- 0006 — Phase 1: Pilot-ready features.
-- Adds HSN codes, cost price, B2B customer fields, bill discounts,
-- round-off, notes, and the customer credit payment ledger.

ALTER TABLE items ADD COLUMN hsn_code TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN cost_price_paise INTEGER NOT NULL DEFAULT 0;

ALTER TABLE customers ADD COLUMN gstin TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN address TEXT NOT NULL DEFAULT '';

ALTER TABLE bills ADD COLUMN discount_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN round_off_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN notes TEXT NOT NULL DEFAULT '';

ALTER TABLE bill_lines ADD COLUMN discount_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bill_lines ADD COLUMN hsn_code TEXT NOT NULL DEFAULT '';

CREATE TABLE customer_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount_paise INTEGER NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'card', 'bank')),
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_customer_payments_customer ON customer_payments (customer_id);
