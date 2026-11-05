// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  changedSinceLastPublish,
  contentHash,
  externalIdOf,
  planPublish,
  stockUnitsOf,
  suggestCategories,
  type PublishItemInput,
} from "../src/publish";

const CAT = "11111111-2222-3333-4444-555555555555";

function item(overrides: Partial<PublishItemInput> = {}): PublishItemInput {
  return {
    id: 1,
    name: "Parle-G Biscuits 56g",
    barcode: "8901719101111",
    categoryId: 3,
    unitKind: "count",
    pricePaise: 1000,
    mrpPaise: 1000,
    stockMilli: 120_000,
    isActive: true,
    photoPath: "/photos/parle.jpg",
    marketplaceCategoryId: CAT,
    lastPublishedHash: null,
    ...overrides,
  };
}

describe("stockUnitsOf", () => {
  it("converts whole units only", () => {
    expect(stockUnitsOf(0)).toBe(0);
    expect(stockUnitsOf(120_000)).toBe(120);
    expect(stockUnitsOf(500)).toBeNull();
    expect(stockUnitsOf(-1000)).toBeNull();
  });
});

describe("planPublish", () => {
  it("marks a complete item ready with its external id and photo state", () => {
    const plan = planPublish([item()], [{ id: CAT }]);
    expect(plan.blocked).toEqual([]);
    expect(plan.ready).toHaveLength(1);
    expect(plan.ready[0]!.externalId).toBe("itm_1");
    expect(plan.ready[0]!.needsPhoto).toBe(false);
    expect(externalIdOf(42)).toBe("itm_42");
  });

  it("flags an item without a photo as needing one (publishes hidden, D9)", () => {
    const plan = planPublish([item({ photoPath: "" })], [{ id: CAT }]);
    expect(plan.ready[0]!.needsPhoto).toBe(true);
  });

  it.each([
    [{ isActive: false }, "inactive"],
    [{ unitKind: "weight" as const }, "not_count"],
    [{ name: "  " }, "empty_name"],
    [{ pricePaise: 0 }, "price_not_positive"],
    [{ categoryId: null }, "no_category"],
    [{ marketplaceCategoryId: null }, "no_category_mapping"],
    [{ stockMilli: 1_500 }, "fractional_stock"],
  ])("blocks %o as %s", (overrides, code) => {
    const plan = planPublish([item(overrides)], [{ id: CAT }]);
    expect(plan.ready).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason.code).toBe(code);
  });

  it("blocks when the mapped marketplace category has vanished", () => {
    const plan = planPublish([item()], [{ id: "other" }]);
    expect(plan.blocked[0]!.reason.code).toBe("no_category_mapping");
  });

  it("keeps ready and blocked items apart without dropping any", () => {
    const plan = planPublish(
      [item({ id: 1 }), item({ id: 2, pricePaise: 0 }), item({ id: 3, name: "Soap" })],
      [{ id: CAT }],
    );
    expect(plan.ready.map((r) => r.input.id)).toEqual([1, 3]);
    expect(plan.blocked.map((b) => b.id)).toEqual([2]);
  });
});

describe("contentHash", () => {
  const base = {
    name: "Soap",
    pricePaise: 4500,
    mrpPaise: 5000,
    stockMilli: 10_000,
    barcode: "123",
    marketplaceCategoryId: CAT,
    isActive: true,
  };

  it("is stable for the same content", () => {
    expect(contentHash(base)).toBe(contentHash({ ...base }));
  });

  it("changes when any billing-owned field changes", () => {
    const variants = [
      { name: "Soap 100g" },
      { pricePaise: 4600 },
      { mrpPaise: 5100 },
      { stockMilli: 11_000 },
      { barcode: "456" },
      { marketplaceCategoryId: "other" },
      { isActive: false },
    ];
    const hashes = new Set([contentHash(base), ...variants.map((v) => contentHash({ ...base, ...v }))]);
    expect(hashes.size).toBe(variants.length + 1);
  });
});

describe("changedSinceLastPublish", () => {
  it("keeps only items whose hash differs from the stored one", () => {
    const plan = planPublish([item({ id: 1 }), item({ id: 2, name: "Soap" })], [{ id: CAT }]);
    const last: Record<number, string | null> = { 1: plan.ready[0]!.hash, 2: null };
    const changed = changedSinceLastPublish(plan.ready, (id) => last[id] ?? null);
    expect(changed.map((c) => c.input.id)).toEqual([2]);
  });
});

describe("suggestCategories", () => {
  const cats = [
    { id: "a", name: "Biscuits & Cookies" },
    { id: "b", name: "Beverages" },
    { id: "c", name: "Biscuits" },
    { id: "d", name: "Snacks" },
  ];

  it("ranks token overlap first, then the shorter name", () => {
    const out = suggestCategories("Biscuits", cats);
    expect(out.map((c) => c.id)).toEqual(["c", "a"]);
    expect(suggestCategories("snacks biscuits", cats).map((c) => c.id)).toEqual(["d", "c", "a"]);
  });

  it("returns nothing when no token overlaps", () => {
    expect(suggestCategories("Detergent", cats)).toEqual([]);
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `Food ${i}` }));
    expect(suggestCategories("food", many, 3)).toHaveLength(3);
  });
});
