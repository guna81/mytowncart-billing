-- SPDX-License-Identifier: Apache-2.0
-- 0005 — B5: catalog fingerprint (price/stock sync without a re-publish) and
-- the read-only online-orders cache.

ALTER TABLE items ADD COLUMN remote_hash TEXT;

CREATE TABLE remote_orders (
  id            TEXT PRIMARY KEY,
  number        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT '',
  total_paise   INTEGER NOT NULL,
  placed_at     TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  lines_json    TEXT NOT NULL,
  synced_at     TEXT NOT NULL
);
CREATE INDEX idx_remote_orders_placed ON remote_orders (placed_at);
