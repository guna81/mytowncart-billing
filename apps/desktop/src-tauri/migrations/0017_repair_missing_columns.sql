-- Marker migration. Databases that were hand-repaired around v15/v16 can be
-- missing columns that 0015/0016 add. SQLite has no ADD COLUMN IF NOT EXISTS,
-- so the actual repair runs in db.rs (repair_missing_columns) when this
-- version is applied. A no-op on healthy and fresh databases.
SELECT 1;
