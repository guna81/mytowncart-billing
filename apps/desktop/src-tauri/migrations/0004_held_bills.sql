-- SPDX-License-Identifier: Apache-2.0
-- 0004 — B1 gap: hold/resume bills survive a restart (roadmap §8.8).
-- A held bill is not a bill yet: no number, no stock movement. Lines are
-- stored as a JSON array of {itemId, qtyMilli}; prices are re-read on resume
-- so a price change between hold and resume is honoured.

CREATE TABLE held_bills (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  label        TEXT NOT NULL,
  customer_id  INTEGER REFERENCES customers(id),
  lines_json   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
