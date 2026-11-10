-- SPDX-License-Identifier: Apache-2.0
-- 0012_item_images: Multi-image support for items

CREATE TABLE item_images (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id           INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  file_name         TEXT NOT NULL,
  image_hash        TEXT NOT NULL,
  is_main           INTEGER NOT NULL DEFAULT 0,
  position          INTEGER NOT NULL DEFAULT 0,
  remote_image_id   TEXT,
  image_uploaded_at TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_item_images_item ON item_images(item_id);

-- Migrate existing single photos from items into item_images
INSERT INTO item_images (item_id, file_name, image_hash, is_main, position, image_uploaded_at, created_at)
SELECT id, photo_path, COALESCE(image_hash, ''), 1, 0, image_uploaded_at, updated_at
FROM items
WHERE photo_path != '';
