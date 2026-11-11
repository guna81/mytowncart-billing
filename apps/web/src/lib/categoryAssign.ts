// SPDX-License-Identifier: Apache-2.0
/**
 * One-step "choose a MyTownCart category" for an item. Billing keeps its own
 * categories, so this finds (or creates) the local category that matches the
 * chosen marketplace category, maps it, and puts the item in it.
 */
import type { BillingRepository, Category, Item } from "@mytowncart-billing/storage";

export interface MarketplaceChoice {
  id: string;
  name: string;
}

export async function assignMarketplaceCategory(
  repo: BillingRepository,
  item: Item,
  categories: readonly Category[],
  choice: MarketplaceChoice,
): Promise<void> {
  // The item already has a local category that just isn't mapped yet: map it.
  if (item.categoryId !== null) {
    await repo.setCategoryMarketplaceId(item.categoryId, choice.id);
    return;
  }
  const existing =
    categories.find((c) => c.marketplaceCategoryId === choice.id) ??
    categories.find((c) => c.name.trim().toLowerCase() === choice.name.trim().toLowerCase());
  const categoryId = existing?.id ?? (await repo.upsertCategory({ name: choice.name.trim() }));
  if (existing?.marketplaceCategoryId !== choice.id) {
    await repo.setCategoryMarketplaceId(categoryId, choice.id);
  }
  await repo.upsertItem({
    id: item.id,
    name: item.name,
    barcode: item.barcode,
    categoryId,
    unitKind: item.unitKind,
    pricePaise: item.pricePaise,
    mrpPaise: item.mrpPaise,
    taxRateBp: item.taxRateBp,
    openingStockMilli: 0, // only applied when creating
    isActive: item.isActive,
    hsnCode: item.hsnCode,
    costPricePaise: item.costPricePaise,
    description: item.description,
    brand: item.brand,
    customAttributes: item.customAttributes,
  });
}
