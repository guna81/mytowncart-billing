-- SPDX-License-Identifier: Apache-2.0
-- 0001_init — B0 bootstrap. The full §8.3 schema arrives in B1.
-- Forward-only: never edit an applied migration; add a new numbered file.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hello_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  written_at TEXT NOT NULL
);
