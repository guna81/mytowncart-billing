// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { planPublish } from "@mytowncart-billing/core";
import type { Category, Item, OutboxRow, RemoteItemLink } from "@mytowncart-billing/storage";
import { classifyCatalogOverview } from "./catalogOverview";
import { toPlanInputs } from "./publishService";

const categories: Category[] = [{ id: 1, name: "Groceries", marketplaceCategoryId: "cat-1" }];
const marketplace = [{ id: "cat-1" }];
function item(overrides: Partial<Item> = {}): Item {
  return {
    id: 1, name: "Rice", barcode: "", categoryId: 1, categoryName: "Groceries",
    unitKind: "count", pricePaise: 1000, mrpPaise: 1200, taxRateBp: 0,
    stockMilli: 5000, isActive: true, photoPath: "", publishState: "local_only",
    remoteProductId: null, remoteVariantId: null, contentHash: null, photoFile: "",
    imageHash: null, imageUploadedAt: null, remoteHash: null, hsnCode: "",
    costPricePaise: 0, description: "", brand: "", customAttributes: {},
    variantGroup: "", variantOptions: {}, updatedAt: "", ...overrides,
  };
}
function linked(overrides: Partial<Item> = {}): Item {
  const base = item(overrides);
  const hash = planPublish(toPlanInputs([base], categories), marketplace).ready[0]!.hash;
  return { ...base, remoteProductId: "product-1", contentHash: hash };
}
function snapshot(overrides: Partial<RemoteItemLink> = {}): Map<string, RemoteItemLink> {
  const remote = { externalId: "itm_1", pricePaise: 1000, stockUnits: 5, remoteHash: "1000:5:1:Rice", ...overrides };
  return new Map([[remote.externalId, remote]]);
}
function outbox(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return { id: 1, idempotencyKey: "key", externalId: "itm_1", deltaUnits: -1,
    reason: "sale", attempts: 0, nextAttemptAt: null, status: "pending", ...overrides };
}
const overview = (items: Item[], seen: ReadonlyMap<string, RemoteItemLink> | null, rows: OutboxRow[] = []) =>
  classifyCatalogOverview(items, categories, marketplace, seen, rows);

describe("classifyCatalogOverview", () => {
  it("plans active items, classifying unlinked ready and all blocked with planner reasons", () => {
    const result = overview([
      item(), item({ id: 2, categoryId: null }), item({ id: 3, unitKind: "weight" }),
      item({ id: 4, isActive: false }), item({ id: 5, remoteProductId: "p", pricePaise: 0 }),
    ], new Map());
    expect(result).toMatchObject({ total: 4, ready: 1, blocked: 3, synced: 0, changed: 0, unknown: 0 });
    expect(result.items.map((x) => x.status)).toEqual(["ready", "blocked", "blocked", "blocked"]);
    expect(result.items[1]).toMatchObject({ reason: { code: "no_category" } });
    expect(result.items[2]).toMatchObject({ reason: { code: "not_count" } });
    expect(result.items[3]).toMatchObject({ reason: { code: "price_not_positive" } });
    expect(classifyCatalogOverview([item()], categories, [], new Map(), []).items[0]).toMatchObject({ reason: { code: "no_category_mapping" } });
  });

  it("requires a linked id, a matching planned hash, and an active matching remote snapshot", () => {
    const result = overview([linked()], snapshot(), [outbox({ status: "done" }), outbox({ externalId: "itm_2" })]);
    expect(result).toMatchObject({ synced: 1, changed: 0, items: [{ status: "synced" }] });
    expect(overview([item()], snapshot()).items[0]).toMatchObject({ status: "ready" });
    expect(overview([linked({ remoteVariantId: "v" })], snapshot()).synced).toBe(1);
  });

  it.each([
    ["content hash", linked(), snapshot(), [], "content_changed"],
    ["pending outbox", linked(), snapshot(), [outbox()], "pending_outbox"],
    ["missing remote", linked(), new Map(), [], "missing_remote"],
    ["remote price", linked(), snapshot({ pricePaise: 999 }), [], "remote_price_changed"],
    ["remote stock", linked(), snapshot({ stockUnits: 4 }), [], "remote_stock_changed"],
  ])("marks %s as changed, never synced", (label, original, seen, rows, reason) => {
    const local = label === "content hash" ? { ...original, description: "changed" } : original;
    const result = overview([local], seen, rows);
    expect(result.synced).toBe(0);
    expect(result.items[0]).toMatchObject({ status: "changed", reasons: [reason] });
  });

  it("does not offer items with a publish hash but missing linkage as new", () => {
    const incompleteLink = { ...linked(), remoteProductId: null };
    expect(overview([incompleteLink], snapshot())).toMatchObject({ ready: 0, synced: null, unknown: 1 });
  });

  it("counts matching hidden products as synced without claiming they are live", () => {
    expect(overview([linked({ publishState: "hidden" })], snapshot({ remoteHash: "1000:5:0:Rice" })).synced).toBe(1);
  });

  it("reports unknown snapshot separately from an empty known snapshot", () => {
    const unknown = overview([linked(), item({ id: 2 })], null);
    expect(unknown).toMatchObject({ total: 2, synced: null, ready: 1, unknown: 1, changed: 0 });
    expect(unknown.items[0]).toMatchObject({ status: "unknown" });
    expect(overview([linked()], new Map())).toMatchObject({ synced: 0, changed: 1 });
    expect(overview([linked()], null, [outbox()])).toMatchObject({ synced: null, changed: 1, unknown: 0 });
  });
});
