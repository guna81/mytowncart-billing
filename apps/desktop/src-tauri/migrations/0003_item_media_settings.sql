-- SPDX-License-Identifier: Apache-2.0
-- 0003 — B2 images (D9) and B3 backup/pilot settings.
-- The remote ids were typed INTEGER in 0002 though the marketplace uses uuids;
-- SQLite has no strict typing, so existing rows keep working and new writes
-- store text. Codes must live in inventory_snapshot; photo_path carries only a
-- private relative file name, never an absolute path.

CREATE TABLE inventory_snapshot (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  item_id     INTEGER REFERENCES items(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_inventory_snapshot_item ON inventory_snapshot (item_id);

ALTER TABLE items ADD COLUMN image_hash TEXT;
ALTER TABLE items ADD COLUMN image_uploaded_at TEXT;

CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
