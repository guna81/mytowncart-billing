// SPDX-License-Identifier: Apache-2.0
/**
 * "Pull": bring products that exist only on MyTownCart into this app. Each one
 * becomes a local item that is linked to the live product (server-side adopt),
 * so later price/stock syncs and publishes update it instead of creating a
 * duplicate. Photos are not pulled; the product keeps its photos on MyTownCart.
 */
import type {
  MarketplaceCategory,
  MarketplaceConnector,
  PlatformProduct,
} from "@mytowncart-billing/connector-mytowncart";
import { externalIdOf } from "@mytowncart-billing/core";
import type { BillingRepository, PublishOutcome } from "@mytowncart-billing/storage";

export interface PullResult {
  pulled: string[];
  failed: { name: string; error: string }[];
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function pullPlatformProducts(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  products: readonly PlatformProduct[],
  marketplace: readonly MarketplaceCategory[],
): Promise<PullResult> {
  const result: PullResult = { pulled: [], failed: [] };
  for (const product of products) {
    try {
      await pullOne(repo, connector, product, marketplace);
      result.pulled.push(product.productId);
    } catch (err) {
      result.failed.push({
        name: product.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

async function pullOne(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  product: PlatformProduct,
  marketplace: readonly MarketplaceCategory[],
): Promise<void> {
  if (product.variantId === null) throw new Error("product has no price/stock record");
  const remoteCategory = marketplace.find((c) => sameName(c.name, product.categoryName));

  let categoryId: number | null = null;
  if (product.categoryName.trim() !== "") {
    const local = (await repo.listCategories()).find((c) => sameName(c.name, product.categoryName));
    categoryId = local?.id ?? (await repo.upsertCategory({ name: product.categoryName.trim() }));
    if (remoteCategory && local?.marketplaceCategoryId !== remoteCategory.id) {
      await repo.setCategoryMarketplaceId(categoryId, remoteCategory.id);
    }
  }

  const itemId = await repo.upsertItem({
    name: product.name,
    barcode: "",
    categoryId,
    unitKind: "count",
    pricePaise: product.pricePaise,
    mrpPaise: 0,
    taxRateBp: 0,
    openingStockMilli: product.stockUnits * 1000,
    isActive: product.isActive,
  });

  const [adopted] = await connector.adoptProducts([
    { productId: product.productId, externalId: externalIdOf(itemId) },
  ]);
  if (adopted === undefined || adopted.status === "error") {
    // No way to delete an item: park it inactive so it can't be published as a duplicate.
    await repo.upsertItem({
      id: itemId,
      name: product.name,
      barcode: "",
      categoryId,
      unitKind: "count",
      pricePaise: product.pricePaise,
      mrpPaise: 0,
      taxRateBp: 0,
      openingStockMilli: 0,
      isActive: false,
    });
    throw new Error(adopted?.error ?? "the server did not confirm the link");
  }
  const outcome: PublishOutcome = {
    itemId,
    state: product.isActive ? "live" : "hidden",
    remoteProductId: adopted.productId,
    remoteVariantId: adopted.variantId,
    contentHash: null,
  };
  await repo.recordPublish([outcome], new Map());
}
