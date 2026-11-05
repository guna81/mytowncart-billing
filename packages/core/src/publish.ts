// SPDX-License-Identifier: Apache-2.0
/**
 * Publish planning (roadmap §8.5): decide, per item, whether this billing
 * catalog can be sent to the marketplace, and what changes since the last
 * publish. Pure — the planner never touches the network.
 *
 * Marketplace limits enforced here mirror the server's F1/D9 rules: stock is
 * integer-only and never negative, and a product needs an active category.
 */

import type { UnitKind } from "./quantity";

export interface PublishItemInput {
  id: number;
  name: string;
  barcode: string;
  categoryId: number | null;
  unitKind: UnitKind;
  pricePaise: number;
  mrpPaise: number;
  stockMilli: number;
  isActive: boolean;
  photoPath: string;
  /** Local category -> marketplace category uuid, confirmed by the seller. */
  marketplaceCategoryId: string | null;
  /** Hash of the content last published successfully; null = never. */
  lastPublishedHash: string | null;
}

export type BlockedReason =
  | { code: "inactive"; message: string }
  | { code: "not_count"; message: string }
  | { code: "empty_name"; message: string }
  | { code: "price_not_positive"; message: string }
  | { code: "no_category"; message: string }
  | { code: "no_category_mapping"; message: string }
  | { code: "fractional_stock"; message: string };

export interface ReadyItem {
  externalId: string;
  input: PublishItemInput;
  /** Content fingerprint of billing-owned fields (see `contentHash`). */
  hash: string;
  /** D9: the marketplace publishes it hidden until a photo arrives. */
  needsPhoto: boolean;
}

export interface BlockedItem {
  id: number;
  name: string;
  reason: BlockedReason;
}

export interface PublishPlan {
  ready: ReadyItem[];
  blocked: BlockedItem[];
}

/** Wire external id for a local item. Stable for the life of the item. */
export function externalIdOf(itemId: number): string {
  return `itm_${itemId}`;
}

/**
 * Integer units for the marketplace. `count` items only; returns null when the
 * ledger holds a fraction (possible after a by-weight import typo) or a
 * negative balance, neither of which the marketplace can represent.
 */
export function stockUnitsOf(stockMilli: number): number | null {
  if (!Number.isSafeInteger(stockMilli) || stockMilli < 0) return null;
  if (stockMilli % 1000 !== 0) return null;
  return stockMilli / 1000;
}

/**
 * FNV-1a over the billing-owned fields (name, price, MRP, stock, barcode,
 * category, active). Photo is excluded on purpose: uploading it must not
 * force a re-publish. Order matters — never reorder the inputs.
 */
export function contentHash(input: {
  name: string;
  pricePaise: number;
  mrpPaise: number;
  stockMilli: number;
  barcode: string;
  marketplaceCategoryId: string;
  isActive: boolean;
}): string {
  const payload = [
    input.name,
    String(input.pricePaise),
    String(input.mrpPaise),
    String(input.stockMilli),
    input.barcode,
    input.marketplaceCategoryId,
    input.isActive ? "1" : "0",
  ].join("\u0001");
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function blockedReasonFor(
  item: PublishItemInput,
  marketplaceCategories: ReadonlySet<string>,
): BlockedReason | null {
  if (!item.isActive) return { code: "inactive", message: "Item is switched off." };
  if (item.unitKind !== "count") {
    return {
      code: "not_count",
      message: "Only per-piece items can be published; loose/by-weight items stay local.",
    };
  }
  if (item.name.trim() === "") return { code: "empty_name", message: "Name is empty." };
  if (!Number.isSafeInteger(item.pricePaise) || item.pricePaise <= 0) {
    return { code: "price_not_positive", message: "Price must be greater than zero." };
  }
  if (item.categoryId === null) return { code: "no_category", message: "Choose a category." };
  if (item.marketplaceCategoryId === null) {
    return { code: "no_category_mapping", message: "Map this category to a marketplace category." };
  }
  if (!marketplaceCategories.has(item.marketplaceCategoryId)) {
    return {
      code: "no_category_mapping",
      message: "The mapped marketplace category no longer exists; map it again.",
    };
  }
  if (stockUnitsOf(item.stockMilli) === null) {
    return {
      code: "fractional_stock",
      message: "Stock must be a whole number of pieces for the marketplace.",
    };
  }
  return null;
}

export function planPublish(
  items: readonly PublishItemInput[],
  marketplaceCategories: readonly { id: string }[],
): PublishPlan {
  const known = new Set(marketplaceCategories.map((c) => c.id));
  const ready: ReadyItem[] = [];
  const blocked: BlockedItem[] = [];
  for (const item of items) {
    const reason = blockedReasonFor(item, known);
    if (reason) {
      blocked.push({ id: item.id, name: item.name, reason });
      continue;
    }
    const category = item.marketplaceCategoryId as string;
    ready.push({
      externalId: externalIdOf(item.id),
      input: item,
      hash: contentHash({
        name: item.name.trim(),
        pricePaise: item.pricePaise,
        mrpPaise: item.mrpPaise,
        stockMilli: item.stockMilli,
        barcode: item.barcode,
        marketplaceCategoryId: category,
        isActive: true,
      }),
      needsPhoto: item.photoPath === "",
    });
  }
  return { ready, blocked };
}

/** Items whose billing-owned content changed since their last publish. */
export function changedSinceLastPublish(
  ready: readonly ReadyItem[],
  lastHash: (itemId: number) => string | null,
): ReadyItem[] {
  return ready.filter((r) => lastHash(r.input.id) !== r.hash);
}

/**
 * Cheap name-similarity suggestions for first-run category mapping: lowercase
 * token overlap, ties broken by shorter name then alphabetically, so the
 * result is deterministic. Returns the best `limit` marketplace categories.
 */
export function suggestCategories(
  localName: string,
  marketplace: readonly { id: string; name: string }[],
  limit = 5,
): { id: string; name: string; score: number }[] {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1),
    );
  const want = tokens(localName);
  const scored = marketplace.map((c) => {
    const have = tokens(c.name);
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    const score = want.size === 0 ? 0 : shared / want.size;
    return { id: c.id, name: c.name, score };
  });
  return scored
    .filter((c) => c.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}
