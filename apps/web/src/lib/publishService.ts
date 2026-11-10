// SPDX-License-Identifier: Apache-2.0
/**
 * Catalog publishing service for MyTownCart Billing.
 * Used for one-by-one publish from the Items list, bulk publishing,
 * and automated catalog sync.
 */

import {
  contentHash,
  IMAGE_MIME,
  localIsoTimestamp,
  planPublish,
  sniffImage,
  stockUnitsOf,
  type BlockedItem,
  type PublishItemInput,
} from "@mytowncart-billing/core";
import type {
  MarketplaceCategory,
  MarketplaceConnector,
  UpsertResult,
} from "@mytowncart-billing/connector-mytowncart";
import type { BillingRepository, Category, Item, PublishOutcome } from "@mytowncart-billing/storage";

export interface PublishResult {
  total: number;
  readyCount: number;
  publishedCount: number;
  failedCount: number;
  blocked: BlockedItem[];
  outcomes: PublishOutcome[];
  errors: string[];
}

/** Wire the catalog as the planner sees it, joined against category mappings. */
export function toPlanInputs(
  items: readonly Item[],
  categories: readonly Category[],
): PublishItemInput[] {
  const mapped = new Map(categories.map((c) => [c.id, c.marketplaceCategoryId]));
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    barcode: item.barcode,
    categoryId: item.categoryId,
    unitKind: item.unitKind,
    pricePaise: item.pricePaise,
    mrpPaise: item.mrpPaise,
    stockMilli: item.stockMilli,
    isActive: item.isActive,
    photoPath: item.photoPath,
    marketplaceCategoryId: item.categoryId === null ? null : (mapped.get(item.categoryId) ?? null),
    lastPublishedHash: item.contentHash,
    description: item.description,
    brand: item.brand,
    customAttributes: item.customAttributes,
  }));
}

/** Honest state for one upsert result, given store approval. */
export function stateForResult(result: UpsertResult, storeApproved: boolean): string {
  if (result.status === "error") return "error";
  if (!storeApproved) return "pending_store_approval";
  return result.visible ? "live" : "hidden";
}

/**
 * Publish a set of items (single or multiple) to MyTownCart marketplace.
 * Handles validation, upserting, uploading pending images, and recording outcomes.
 */
export async function publishCatalogItems(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  itemsToPublish: readonly Item[],
  sellerIsApproved: boolean,
  options: { uploadPhotos?: boolean } = {},
): Promise<PublishResult> {
  const shouldUploadPhotos = options.uploadPhotos !== false;
  const errors: string[] = [];

  if (itemsToPublish.length === 0) {
    return {
      total: 0,
      readyCount: 0,
      publishedCount: 0,
      failedCount: 0,
      blocked: [],
      outcomes: [],
      errors: [],
    };
  }

  // 1. Fetch local categories and remote marketplace categories
  const [categories, marketplaceCategories] = await Promise.all([
    repo.listCategories(),
    connector.listCategories().catch((err) => {
      errors.push(`Could not load marketplace categories: ${err instanceof Error ? err.message : String(err)}`);
      return [] as MarketplaceCategory[];
    }),
  ]);

  if (marketplaceCategories.length === 0 && errors.length > 0) {
    return {
      total: itemsToPublish.length,
      readyCount: 0,
      publishedCount: 0,
      failedCount: itemsToPublish.length,
      blocked: [],
      outcomes: [],
      errors,
    };
  }

  // 2. Plan publish
  const plan = planPublish(toPlanInputs(itemsToPublish, categories), marketplaceCategories);

  if (plan.ready.length === 0) {
    return {
      total: itemsToPublish.length,
      readyCount: 0,
      publishedCount: 0,
      failedCount: plan.blocked.length,
      blocked: plan.blocked,
      outcomes: [],
      errors,
    };
  }

  // 3. Upsert ready items to marketplace
  let results: UpsertResult[] = [];
  try {
    results = await connector.upsertItems(
      plan.ready.map((r) => ({
        externalId: r.externalId,
        name: r.input.name.trim(),
        pricePaise: r.input.pricePaise,
        mrpPaise: r.input.mrpPaise,
        stockUnits: stockUnitsOf(r.input.stockMilli) ?? 0,
        barcode: r.input.barcode === "" ? null : r.input.barcode,
        categoryId: r.input.marketplaceCategoryId as string,
        isActive: r.input.isActive,
        contentHash: r.hash,
        description: r.input.description,
        brand: r.input.brand,
        customAttributes: r.input.customAttributes,
      })),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Publish failed: ${msg}`);
    return {
      total: itemsToPublish.length,
      readyCount: plan.ready.length,
      publishedCount: 0,
      failedCount: plan.ready.length,
      blocked: plan.blocked,
      outcomes: [],
      errors,
    };
  }

  // 4. Upload pending photos if enabled
  if (shouldUploadPhotos) {
    for (const r of plan.ready) {
      const item = itemsToPublish.find((i) => i.id === r.input.id);
      if (!item) continue;
      try {
        const images = await repo.listItemImages(item.id);
        if (images.length > 0) {
          const sorted = [...images].sort(
            (a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || a.position - b.position,
          );
          for (const img of sorted) {
            if (img.imageUploadedAt !== img.imageHash) {
              try {
                const photo = await repo.readItemImage(img.id);
                if (photo && photo.imageHash === img.imageHash) {
                  const blob = new Blob([photo.bytes as BlobPart], {
                    type: IMAGE_MIME[sniffImage(photo.bytes) ?? "jpeg"],
                  });
                  await connector.uploadImage(r.externalId, blob, img.isMain);
                  await repo.recordImageUploads([
                    {
                      itemId: item.id,
                      imageHash: img.imageHash,
                      uploadedAt: localIsoTimestamp(new Date()),
                    },
                  ]);
                }
              } catch {
                // Failure to upload a photo must not abort the publish outcome
              }
            }
          }
        } else if (
          item.photoFile !== "" &&
          item.imageHash !== null &&
          item.imageUploadedAt !== item.imageHash
        ) {
          const photo = await repo.readItemPhoto(item.id);
          if (photo && photo.imageHash === item.imageHash) {
            const blob = new Blob([photo.bytes as BlobPart], {
              type: IMAGE_MIME[sniffImage(photo.bytes) ?? "jpeg"],
            });
            await connector.uploadImage(r.externalId, blob, !item.imageUploadedAt);
            await repo.recordImageUploads([
              {
                itemId: item.id,
                imageHash: item.imageHash,
                uploadedAt: localIsoTimestamp(new Date()),
              },
            ]);
          }
        }
      } catch {
        // Failure to inspect or upload photos must not abort publish
      }
    }
  }

  // 5. Calculate outcomes and save
  const byExternal = new Map(results.map((r) => [r.externalId, r]));
  const outcomes: PublishOutcome[] = plan.ready.map((r) => {
    const result = byExternal.get(r.externalId);
    const state = result ? stateForResult(result, sellerIsApproved) : "error";
    return {
      itemId: r.input.id,
      state,
      remoteProductId: result?.productId ?? null,
      remoteVariantId: result?.variantId ?? null,
      contentHash: result && result.status !== "error" ? r.hash : null,
    };
  });

  const mappings = new Map(
    categories.flatMap((c) =>
      c.marketplaceCategoryId === null ? [] : [[c.id, c.marketplaceCategoryId] as const],
    ),
  );
  await repo.recordPublish(outcomes, mappings);

  const successfulCount = outcomes.filter((o) => o.state !== "error").length;
  const failedUpsertCount = outcomes.filter((o) => o.state === "error").length;

  return {
    total: itemsToPublish.length,
    readyCount: plan.ready.length,
    publishedCount: successfulCount,
    failedCount: failedUpsertCount + plan.blocked.length,
    blocked: plan.blocked,
    outcomes,
    errors,
  };
}

/** Check if an item's published content has been modified since it was last published. */
export function isItemModified(item: Item, marketplaceCategoryId: string | null): boolean {
  if (!item.contentHash || !marketplaceCategoryId) return false;
  const hash = contentHash({
    name: item.name.trim(),
    pricePaise: item.pricePaise,
    mrpPaise: item.mrpPaise,
    stockMilli: item.stockMilli,
    barcode: item.barcode,
    marketplaceCategoryId,
    isActive: item.isActive,
  });
  return hash !== item.contentHash;
}

/** Check marketplace publish status of an item: live, hidden, changed, not_published, blocked, error. */
export function getItemPublishStatus(
  item: Item,
  categoryMapped: boolean,
  marketplaceCategoryId?: string | null,
): { status: "live" | "hidden" | "changed" | "not_published" | "blocked" | "error"; reason?: string } {
  if (item.categoryId === null) {
    return { status: "blocked", reason: "no_category" };
  }
  if (!categoryMapped) {
    return { status: "blocked", reason: "no_category_mapping" };
  }
  if (item.unitKind !== "count") {
    return { status: "blocked", reason: "not_count" };
  }
  if (item.pricePaise <= 0) {
    return { status: "blocked", reason: "price_not_positive" };
  }
  if (stockUnitsOf(item.stockMilli) === null) {
    return { status: "blocked", reason: "fractional_stock" };
  }

  if (item.publishState === "error") {
    return { status: "error" };
  }

  if (item.publishState === "local_only" || !item.contentHash) {
    return { status: "not_published" };
  }

  if (marketplaceCategoryId && isItemModified(item, marketplaceCategoryId)) {
    return { status: "changed" };
  }

  if (item.publishState === "hidden") {
    return { status: "hidden" };
  }

  return { status: "live" };
}
