-- SPDX-License-Identifier: Apache-2.0
-- 0011_item_details: Add description, brand, and custom_attributes to items

ALTER TABLE items ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN brand TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN custom_attributes TEXT NOT NULL DEFAULT '{}';
CREATE INDEX idx_items_brand ON items (brand);
