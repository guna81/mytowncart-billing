// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type {
  MarketplaceConnector,
  PublishItem,
  UpsertResult,
} from "@mytowncart-billing/connector-mytowncart";
import { MemoryRepository } from "@mytowncart-billing/storage";
import { getItemPublishStatus, publishCatalogItems } from "./publishService";

function mockConnector(overrides: Partial<MarketplaceConnector> = {}): MarketplaceConnector {
  const ok = (items: PublishItem[]): UpsertResult[] =>
    items.map((i) => ({
      externalId: i.externalId,
      productId: `p-${i.externalId}`,
      variantId: `v-${i.externalId}`,
      status: "updated",
      visible: true,
      error: null,
    }));

  const base: MarketplaceConnector = {
    connect: () => Promise.reject(new Error("unused")),
    me: () => Promise.reject(new Error("unused")),
    listCategories: () => Promise.resolve([{ id: "cat-1", name: "Groceries", parentId: null }]),
    upsertItems: (items) => Promise.resolve(ok(items)),
    uploadImage: () => Promise.resolve(),
    pushStock: () => Promise.resolve([]),
    pullStock: () => Promise.resolve({ moves: [], nextCursor: 0 }),
    pullOrders: () => Promise.resolve({ orders: [] }),
    listRemoteItems: () => Promise.resolve([]),
  };
  return { ...base, ...overrides };
}

describe("publishService", () => {
  it("publishes a ready single item and records publish outcome", async () => {
    const repo = new MemoryRepository();
    const catId = await repo.upsertCategory({ name: "Groceries" });
    await repo.setCategoryMarketplaceId(catId, "cat-1");

    const itemId = await repo.upsertItem({
      name: "Rice 1kg",
      barcode: "8901234567890",
      categoryId: catId,
      unitKind: "count",
      pricePaise: 5000,
      mrpPaise: 6000,
      taxRateBp: 0,
      openingStockMilli: 10000,
      isActive: true,
    });

    const items = await repo.listItems({ activeOnly: false });
    const item = items.find((i) => i.id === itemId)!;

    let upsertCalled = false;
    const connector = mockConnector({
      upsertItems: (pItems) => {
        upsertCalled = true;
        expect(pItems.length).toBe(1);
        expect(pItems[0]!.name).toBe("Rice 1kg");
        return Promise.resolve([
          {
            externalId: pItems[0]!.externalId,
            productId: "prod-123",
            variantId: "var-123",
            status: "created",
            visible: true,
            error: null,
          },
        ]);
      },
    });

    const result = await publishCatalogItems(repo, connector, [item], true);

    expect(upsertCalled).toBe(true);
    expect(result.publishedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.blocked.length).toBe(0);

    const updated = (await repo.listItems({ activeOnly: false })).find((i) => i.id === itemId)!;
    expect(updated.publishState).toBe("live");
    expect(updated.remoteProductId).toBe("prod-123");
    expect(updated.contentHash).not.toBeNull();
  });

  it("handles blocked items (e.g. unmapped category)", async () => {
    const repo = new MemoryRepository();
    const catId = await repo.upsertCategory({ name: "Unmapped Cat" });
    // Not mapped to any marketplace category

    const itemId = await repo.upsertItem({
      name: "Sugar 1kg",
      barcode: "8901234567891",
      categoryId: catId,
      unitKind: "count",
      pricePaise: 4000,
      mrpPaise: 4500,
      taxRateBp: 0,
      openingStockMilli: 5000,
      isActive: true,
    });

    const items = await repo.listItems({ activeOnly: false });
    const item = items.find((i) => i.id === itemId)!;

    const connector = mockConnector();
    const result = await publishCatalogItems(repo, connector, [item], true);

    expect(result.publishedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.blocked.length).toBe(1);
    expect(result.blocked[0]!.reason.code).toBe("no_category_mapping");
  });

  it("publishes multiple items in bulk", async () => {
    const repo = new MemoryRepository();
    const catId = await repo.upsertCategory({ name: "Groceries" });
    await repo.setCategoryMarketplaceId(catId, "cat-1");

    const id1 = await repo.upsertItem({
      name: "Item 1",
      barcode: "111",
      categoryId: catId,
      unitKind: "count",
      pricePaise: 1000,
      mrpPaise: 1000,
      taxRateBp: 0,
      openingStockMilli: 2000,
      isActive: true,
    });
    const id2 = await repo.upsertItem({
      name: "Item 2",
      barcode: "222",
      categoryId: catId,
      unitKind: "count",
      pricePaise: 2000,
      mrpPaise: 2000,
      taxRateBp: 0,
      openingStockMilli: 3000,
      isActive: true,
    });

    const items = await repo.listItems({ activeOnly: false });
    const connector = mockConnector();

    const result = await publishCatalogItems(repo, connector, items, true);

    expect(result.total).toBe(2);
    expect(result.publishedCount).toBe(2);
    expect(result.failedCount).toBe(0);
  });

  it("reports correct publish status using getItemPublishStatus", async () => {
    const itemWithoutCategory = {
      id: 1,
      name: "No Cat",
      barcode: "",
      categoryId: null,
      categoryName: null,
      unitKind: "count" as const,
      pricePaise: 1000,
      mrpPaise: 1000,
      taxRateBp: 0,
      stockMilli: 1000,
      isActive: true,
      photoPath: "",
      publishState: "local_only",
      remoteProductId: null,
      remoteVariantId: null,
      contentHash: null,
      photoFile: "",
      imageHash: null,
      imageUploadedAt: null,
      remoteHash: null,
      hsnCode: "",
      costPricePaise: 0,
      description: "",
      brand: "",
      customAttributes: {},
      updatedAt: "",
    };

    expect(getItemPublishStatus(itemWithoutCategory, false).status).toBe("blocked");
    expect(getItemPublishStatus(itemWithoutCategory, false).reason).toBe("no_category");

    const unmappedItem = { ...itemWithoutCategory, categoryId: 10 };
    expect(getItemPublishStatus(unmappedItem, false).status).toBe("blocked");
    expect(getItemPublishStatus(unmappedItem, false).reason).toBe("no_category_mapping");

    const readyItem = { ...unmappedItem };
    expect(getItemPublishStatus(readyItem, true).status).toBe("not_published");

    const liveItem = { ...readyItem, publishState: "live", contentHash: "hash123" };
    expect(getItemPublishStatus(liveItem, true).status).toBe("live");

    const hiddenItem = { ...readyItem, publishState: "hidden", contentHash: "hash123" };
    expect(getItemPublishStatus(hiddenItem, true).status).toBe("hidden");

    // Item modified compared to its published content hash
    const changedItem = { ...liveItem, pricePaise: 9999 };
    expect(getItemPublishStatus(changedItem, true, "cat-1").status).toBe("changed");
  });

  it("publishes multi-images for ready items and tracks upload status", async () => {
    const repo = new MemoryRepository();
    const catId = await repo.upsertCategory({ name: "Snacks" });
    await repo.setCategoryMarketplaceId(catId, "cat-1");

    const itemId = await repo.upsertItem({
      name: "Biscuit Box",
      barcode: "8901234567899",
      categoryId: catId,
      unitKind: "count",
      pricePaise: 2000,
      mrpPaise: 2500,
      taxRateBp: 0,
      openingStockMilli: 5000,
      isActive: true,
    });

    const bytes1 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 10]);
    const bytes2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 20]);
    await repo.addItemImage(itemId, bytes1, "biscuit-cover", true);
    await repo.addItemImage(itemId, bytes2, "biscuit-back", false);

    const uploads: { externalId: string; isMain?: boolean }[] = [];
    const connector = mockConnector({
      uploadImage: (externalId, _file, isMain) => {
        uploads.push({ externalId, isMain });
        return Promise.resolve({ imageId: `img-${uploads.length}`, isMain: Boolean(isMain), isActive: true });
      },
    });

    const items = await repo.listItems({ activeOnly: false });
    const item = items.find((i) => i.id === itemId)!;

    const res = await publishCatalogItems(repo, connector, [item], true, { uploadPhotos: true });
    expect(res.publishedCount).toBe(1);
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toEqual({ externalId: "itm_1", isMain: true });
    expect(uploads[1]).toEqual({ externalId: "itm_1", isMain: false });

    // Verify both images are recorded as uploaded
    const itemImages = await repo.listItemImages(itemId);
    expect(itemImages[0]?.imageUploadedAt).not.toBeNull();
    expect(itemImages[1]?.imageUploadedAt).not.toBeNull();
  });
});
