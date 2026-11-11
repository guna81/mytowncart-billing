// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { MemoryRepository } from "@mytowncart-billing/storage";

import { assignMarketplaceCategory } from "./categoryAssign";

async function setup(withCategory: boolean) {
  const repo = new MemoryRepository();
  const localCat = withCategory ? await repo.upsertCategory({ name: "Cables" }) : null;
  const id = await repo.upsertItem({
    name: "Data Cable",
    barcode: "",
    categoryId: localCat,
    unitKind: "count",
    pricePaise: 40_000,
    mrpPaise: 50_000,
    taxRateBp: 0,
    openingStockMilli: 2000,
    isActive: true,
    brand: "Acme",
  });
  const item = (await repo.listItems({ activeOnly: false })).find((i) => i.id === id)!;
  return { repo, item, localCat };
}

describe("assignMarketplaceCategory", () => {
  it("creates, maps and assigns a local category for an uncategorised item", async () => {
    const { repo, item } = await setup(false);
    await assignMarketplaceCategory(repo, item, await repo.listCategories(), {
      id: "mp-1",
      name: "Cables & Chargers",
    });
    const cats = await repo.listCategories();
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ name: "Cables & Chargers", marketplaceCategoryId: "mp-1" });
    const after = (await repo.listItems({ activeOnly: false }))[0]!;
    expect(after.categoryId).toBe(cats[0]!.id);
    // nothing else on the item changes, stock included
    expect(after).toMatchObject({ name: "Data Cable", pricePaise: 40_000, stockMilli: 2000, brand: "Acme" });
  });

  it("reuses a local category already mapped to the choice", async () => {
    const { repo, item, localCat } = await setup(false);
    const existing = await repo.upsertCategory({ name: "Chargers" });
    await repo.setCategoryMarketplaceId(existing, "mp-1");
    void localCat;
    await assignMarketplaceCategory(repo, item, await repo.listCategories(), { id: "mp-1", name: "Cables & Chargers" });
    expect(await repo.listCategories()).toHaveLength(1);
    expect((await repo.listItems({ activeOnly: false }))[0]!.categoryId).toBe(existing);
  });

  it("only maps the item's own local category when it already has one", async () => {
    const { repo, item, localCat } = await setup(true);
    await assignMarketplaceCategory(repo, item, await repo.listCategories(), { id: "mp-2", name: "Anything" });
    const cats = await repo.listCategories();
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ id: localCat, marketplaceCategoryId: "mp-2" });
  });
});
