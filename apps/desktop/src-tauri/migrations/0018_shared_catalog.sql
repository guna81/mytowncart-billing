ALTER TABLE items ADD COLUMN catalog_entry_id TEXT;
CREATE INDEX items_catalog_entry_idx ON items(catalog_entry_id);
