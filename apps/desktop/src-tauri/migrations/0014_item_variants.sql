-- SPDX-License-Identifier: Apache-2.0
-- 0014_item_variants: items that are sizes/options of one product share a
-- variant_group; variant_options holds that item's own values ({"Size":"M"}).
-- Every existing item stays a plain single item (empty group).

ALTER TABLE items ADD COLUMN variant_group TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN variant_options TEXT NOT NULL DEFAULT '{}';
CREATE INDEX idx_items_variant_group ON items (variant_group) WHERE variant_group != '';
