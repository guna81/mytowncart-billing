// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type {
  AdoptResult,
  MarketplaceConnector,
  PlatformProduct,
} from "@mytowncart-billing/connector-mytowncart";
import { MemoryRepository } from "@mytowncart-billing/storage";
import { pullPlatformProducts } from "./pullService";

const product: PlatformProduct = {
  productId: "p-1",
  variantId: "v-1",
  name: "Hand Soap",
  categoryName: "Grocery",
  pricePaise: 4500,
  stockUnits: 7,
  isActive: true,
};
const marketplace = [{ id: "mc-1", name: "Grocery", parentId: null }];

function connector(adopt: (externalId: string) => AdoptResult): MarketplaceConnector {
  return {
    adoptProducts: (entries: { productId: string; externalId: string }[]) =>
      Promise.resolve(entries.map((e) => adopt(e.externalId))),
  } as unknown as MarketplaceConnector;
}

const adopted = (externalId: string): AdoptResult => ({
  externalId,
  productId: "p-1",
  variantId: "v-1",
  status: "adopted",
  visible: true,
  error: null,
});

describe("pullPlatformProducts", () => {
  it("creates a linked local item with category, price and stock", async () => {
    const repo = new MemoryRepository();
    const result = await pullPlatformProducts(repo, connector(adopted), [product], marketplace);
    expect(result.failed).toEqual([]);
    const [item] = (await repo.listItems({ activeOnly: false })).filter((i) => i.name === "Hand Soap");
    expect(item?.pricePaise).toBe(4500);
    expect(item?.stockMilli).toBe(7000);
    expect(item?.remoteProductId).toBe("p-1");
    expect(item?.remoteVariantId).toBe("v-1");
    expect(item?.publishState).toBe("live");
    const category = (await repo.listCategories()).find((c) => c.name === "Grocery");
    expect(category?.marketplaceCategoryId).toBe("mc-1");
  });

  it("parks the item inactive and reports it when the server refuses the link", async () => {
    const repo = new MemoryRepository();
    const refuse = (externalId: string): AdoptResult => ({
      ...adopted(externalId),
      status: "error",
      productId: null,
      error: "That external_id is already in use.",
    });
    const result = await pullPlatformProducts(repo, connector(refuse), [product], marketplace);
    expect(result.pulled).toEqual([]);
    expect(result.failed[0]?.error).toBe("That external_id is already in use.");
    const item = (await repo.listItems({ activeOnly: false })).find((i) => i.name === "Hand Soap");
    expect(item?.isActive).toBe(false);
    expect(item?.remoteProductId).toBeNull();
  });
});
