// SPDX-License-Identifier: Apache-2.0
/**
 * B5 two-way sync (roadmap §8.6), driven from MyTownCart → Sync.
 *
 * - push: durable, ordered, immutable source deliveries are claimed before
 *   network I/O and settled with the exact claim token. Retries reuse payloads.
 * - catalog: stock-neutral metadata upserts use the per-item content hash.
 * - pull: the remote stock feed advances `stock_cursor` in the same
 *   transaction as the applied moves, so a crash can neither replay nor
 *   skip a page.
 * - snapshot: the marketplace's current values are cached for the reconcile
 *   view. (Online orders are handled in the MyTownCart seller app.)
 */
import {
  MarketplaceError,
  type MarketplaceConnector,
  type RemoteItem,
  type StockPush,
} from "@mytowncart-billing/connector-mytowncart";
import {
  externalIdOf,
  IMAGE_MIME,
  localIsoTimestamp,
  planPublish,
  reconcile,
  remoteHashOf,
  sniffImage,
  stockUnitsOf,
  type PublishItemInput,
  type ReconcileInput,
  type ReconcileRow,
  type RemoteItemRef,
} from "@mytowncart-billing/core";
import type {
  BillingRepository,
  Category,
  Item,
  ReconcileFix,
  RemoteItemLink,
} from "@mytowncart-billing/storage";

import { isInTauri, isLanServer } from "./repository";
import { pullPlatformProducts } from "./pullService";
import { loadPlatformOnly, removeFromPlatformOnly, savePlatformOnly } from "./platformOnly";
import { groupOf } from "./variantSync";
import { syncPhotos } from "./photoSync";
import { loadRemoteSeen, saveRemoteSeen } from "./remoteSeen";
import { descriptionFingerprint, toWireHtml } from "./richText";
import { activeStockSources, recoverStockReconciliations } from "./reconcileFixes";

/** Server cap from `me/`; never ask for more. */
export const DEFAULT_BULK_MAX = 100;
const PULL_PAGE_CAP = 50;
const MAX_ATTEMPTS_WITH_BACKOFF = 10;

export interface SyncOutcome {
  at: string;
  pushedMoves: number;
  pulledMoves: number;
  restocked: number;
  catalogSent: number;
  catalogFailed: number;
  /** Items created here from MyTownCart-only products, and prices taken from MyTownCart. */
  pulledItems?: number;
  pulledPrices?: number;
  /** Names taken from MyTownCart. */
  pulledNames?: number;
  /** Descriptions (rich text) brought in from MyTownCart. */
  pulledDescriptions?: number;
  /** Main photos taken from MyTownCart (the later change wins). */
  pulledPhotos?: number;
  /** Seconds until a throttled or paginated stock pull can be retried. */
  retryAfterSeconds?: number;
  /** Problems phrased for the seller, one line per failed step. */
  problems: string[];
}

export interface SyncDeps {
  repo: BillingRepository;
  connector: MarketplaceConnector;
  now(): Date;
  isApproved(): boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toPlanInputs(items: readonly Item[], categories: readonly Category[]): PublishItemInput[] {
  const mapped = new Map(categories.map((c) => [c.id, c.marketplaceCategoryId ?? null]));
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
    description: toWireHtml(item.description ?? ""),
    brand: item.brand,
    customAttributes: item.customAttributes,
  }));
}


export async function runSync(
  deps: SyncDeps,
  options: {
    bulkMax?: number;
    force?: boolean;
    platformOnly?: boolean;
    /** Run the lightweight stock path without a catalog or photo scan. */
    stockOnly?: boolean;
    /** Whether this run should poll the stock feed (default true). */
    pullStock?: boolean;
    /** Keep items already on MyTownCart up to date: name, description, price, stock. Default on. */
    details?: boolean;
    /** Publish eligible items (a photo is optional: without one the server keeps it hidden) that are not on MyTownCart yet. Default on. */
    list?: boolean;
  } = {},
): Promise<SyncOutcome> {
  const { repo, connector } = deps;
  const now = deps.now();
  const outcome: SyncOutcome = {
    at: now.toISOString(),
    pushedMoves: 0,
    pulledMoves: 0,
    restocked: 0,
    catalogSent: 0,
    catalogFailed: 0,
    problems: [],
  };

  const bulkMax = Math.min(Math.max(1, options.bulkMax ?? DEFAULT_BULK_MAX), DEFAULT_BULK_MAX);
  const details = options.details !== false;
  const list = options.list !== false;
  // Each claim persists its immutable request before any network I/O.
  if (details) {
    try { await recoverStockReconciliations(repo, connector); }
    catch (err) { outcome.problems.push(`stock reconciliation: ${message(err)}`); }
    await pushStock(repo, connector, now, outcome, bulkMax);
  }
  if (!options.stockOnly && (details || list)) {
    try {
      await pushCatalog(repo, connector, outcome, { details, list });
    } catch (err) {
      outcome.problems.push(`catalog: ${message(err)}`);
    }
  }
  if (details && options.pullStock !== false) await pullStock(repo, connector, outcome, options.force);
  if (!options.stockOnly) await recordSnapshot(repo, connector, now, outcome, details);
  if (!options.stockOnly && options.platformOnly) {
    await recordPlatformOnly(connector, now, outcome);
    if (list) await autoPullNew(repo, connector, outcome);
  }
  return outcome;
}

/** Ordered source deliveries; no netting, fresh retry keys or broad acknowledgement. */
async function pushStock(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  now: Date,
  outcome: SyncOutcome,
  bulkMax: number,
): Promise<void> {
  // A fixed cap prevents continuously arriving sales from extending this run.
  for (let index = 0; index < bulkMax; index++) {
    const claim = await repo.claimStockDelivery(now.toISOString(), new Date(now.getTime() + 120_000).toISOString());
    if (!claim) break;
    let move: StockPush;
    try {
      move = JSON.parse(claim.payloadJson) as StockPush;
      if (!move || move.idempotencyKey !== claim.idempotencyKey ||
          typeof move.externalId !== "string" || !Number.isSafeInteger(move.deltaUnits) ||
          !["sale", "adjustment", "order_cancel"].includes(move.reason)) {
        throw new Error("Invalid immutable stock delivery");
      }
    } catch (err) {
      await repo.settleStockDelivery(claim.id, claim.claimToken, "quarantined", undefined, message(err));
      outcome.problems.push(`stock push: ${message(err)}`);
      continue;
    }
    let result;
    try {
      const results = await connector.pushStock([move]);
      result = results.find((entry) => entry.idempotencyKey === move.idempotencyKey);
    } catch (err) {
      const attempts = Math.min(claim.attempts + 1, MAX_ATTEMPTS_WITH_BACKOFF);
      const delay = Math.min(30_000 * 2 ** attempts, 30 * 60_000);
      await repo.settleStockDelivery(claim.id, claim.claimToken, "retry", new Date(now.getTime() + delay).toISOString(), message(err));
      outcome.problems.push(`stock push: ${message(err)}`);
      continue;
    }
    const definitive = result && (result.status === "applied" || result.status === "duplicate") && result.clamped === false;
    const detail = definitive ? undefined : result?.error ?? "Stock result is missing, rejected, clamped or unknown; review stock reconciliation";
    // A local settlement error is not a network retry: leave the exact claim
    // recoverable and do not acknowledge any other source for this item.
    await repo.settleStockDelivery(claim.id, claim.claimToken, definitive ? "done" : "quarantined", undefined, detail);
    if (definitive) outcome.pushedMoves++;
    else outcome.problems.push(`${move.externalId}: ${detail}`);
  }
}

async function pushCatalog(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  outcome: SyncOutcome,
  scope: { details: boolean; list: boolean },
): Promise<void> {
  const [items, categories, marketplace] = await Promise.all([
    repo.listItems({ activeOnly: false }),
    repo.listCategories(),
    connector.listCategories(),
  ]);
  if (marketplace.length === 0) return;

  const plan = planPublish(toPlanInputs(items, categories), marketplace);
  // Items the seller unpublished locally are sent as inactive, not skipped.
  const linkedIds = new Set(
    items.filter((i) => i.remoteProductId !== null || i.contentHash !== null).map((i) => i.id),
  );
  const changed = plan.ready
    .filter((r) => r.input.lastPublishedHash === null || r.input.lastPublishedHash !== r.hash)
    // Already on MyTownCart → "details"; not there yet → "the list".
    .filter((r) => (linkedIds.has(r.input.id) ? scope.details : scope.list));
  if (changed.length === 0) return;

  // The seller emptied a description that had text at the last look → say so
  // explicitly. An empty value is otherwise never sent, so a description written
  // on MyTownCart is never blanked by accident.
  const descBaseline = await loadDescBaseline(repo);
  const emptyFp = descriptionFingerprint("");
  try {
    const results = await connector.upsertItems(
      changed.map((r) => ({
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
        clearDescription:
          descriptionFingerprint(r.input.description ?? "") === emptyFp &&
          descBaseline[r.externalId] !== undefined &&
          descBaseline[r.externalId]!.l !== emptyFp,
        brand: r.input.brand,
        customAttributes: r.input.customAttributes,
        ...groupOf(items.find((i) => i.id === r.input.id)),
      })),
    );
    const byExternal = new Map(results.map((r) => [r.externalId, r]));

    // Upload photos for items with pending local photos so they become visible
    for (const r of changed) {
      const item = items.find((i) => i.id === r.input.id);
      if (!item) continue;
      try {
        const images = await repo.listItemImages(item.id);
        if (images.length > 0) {
          const sorted = [...images].sort(
            (a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || a.position - b.position,
          );
          for (const img of sorted) {
            if (img.imageUploadedAt === null) {
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
                // Failure to upload a photo must not abort catalog sync
              }
            }
          }
        } else if (
          item.photoFile !== "" &&
          item.imageHash !== null &&
          item.imageUploadedAt === null
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
        // Failure to inspect or upload photos must not abort catalog sync
      }
    }

    await repo.recordPublish(
      changed.map((r) => {
        const result = byExternal.get(r.externalId);
        const ok = result !== undefined && result.status !== "error";
        if (!ok) outcome.catalogFailed += 1;
        else outcome.catalogSent += 1;
        return {
          itemId: r.input.id,
          state: !ok ? "error" : result.visible ? "live" : "hidden",
          remoteProductId: result?.productId ?? null,
          remoteVariantId: result?.variantId ?? null,
          contentHash: ok ? r.hash : null,
        };
      }),
      new Map(
        categories.flatMap((c) =>
          c.marketplaceCategoryId === null ? [] : [[c.id, c.marketplaceCategoryId] as const],
        ),
      ),
    );
  } catch (err) {
    outcome.problems.push(`catalog: ${message(err)}`);
  }
}

async function pullStock(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  outcome: SyncOutcome,
  force = false,
): Promise<void> {
  let expectedCursor = await repo.getSyncCursor("stock");
  const stored = Number(expectedCursor ?? "0");
  let cursor = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
  try {
    const epoch = await repo.getAppSetting("sync.stock_epoch");
    if (!epoch) throw new Error("Stock feed bootstrap required: no stock epoch yet");
    if (await repo.getAppSetting("sync.stock_bootstrap_required") === "true") {
      throw new Error("Stock feed bootstrap required after protocol upgrade; stock pull is paused to protect historical balances");
    }
    let continuation: string | undefined;
    for (let page = 0; page < PULL_PAGE_CAP; page++) {
      const feed = await connector.pullStock(cursor, { force, continuation, epoch });
      if (feed.epoch !== epoch) throw new Error("Stock feed epoch changed; bootstrap required");
      if (feed.nextCursor === cursor && feed.moves.length === 0) {
        if (feed.hasMore) throw new Error("stock feed did not advance its cursor");
        break;
      }
      if (!Number.isSafeInteger(feed.nextCursor) || feed.nextCursor <= cursor) {
        throw new Error("stock feed returned an invalid cursor");
      }
      const applied = await repo.applyStockPull(
        expectedCursor,
        String(feed.nextCursor),
        feed.moves.map((m) => ({
          externalId: m.externalId,
          deltaUnits: m.deltaUnits,
          reason: m.reason,
          createdAt: m.createdAt,
          epoch: m.epoch ?? feed.epoch,
          sequence: m.sequence,
        })),
      );
      outcome.pulledMoves += applied.filter((a) => a.itemId !== null).length;
      cursor = feed.nextCursor;
      expectedCursor = String(cursor);
      if (feed.hasMore === false) break;
      continuation = feed.continuation ?? undefined;
      // No continuation token: resume from the committed cursor after the
      // polling interval instead of repeatedly hitting 429.
      if (!force && !continuation) {
        outcome.retryAfterSeconds = 120;
        break;
      }
      if (page === PULL_PAGE_CAP - 1) outcome.retryAfterSeconds = 120;
    }
  } catch (err) {
    if (err instanceof MarketplaceError && err.status === 429) {
      outcome.retryAfterSeconds = Math.max(1, err.retryAfterSeconds ?? 120);
    } else {
      outcome.problems.push(`stock pull: ${message(err)}`);
    }
  }
}

function remoteItemHash(r: RemoteItem): string {
  // The name goes last: it may itself contain ":".
  const base = `${r.pricePaise}:${r.stockUnits}:${r.isActive ? 1 : 0}`;
  return r.name === undefined ? base : `${base}:${r.name}`;
}

function toLinks(remote: readonly RemoteItem[]): RemoteItemLink[] {
  return remote.map((r) => ({
    externalId: r.externalId,
    stockUnits: r.stockUnits,
    pricePaise: r.pricePaise,
    remoteHash: remoteItemHash(r),
  }));
}

async function recordSnapshot(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  now: Date,
  outcome: SyncOutcome,
  details = false,
): Promise<void> {
  try {
    const remoteItems = await connector.listRemoteItems();
    if (details) {
      await pullFromRemote(repo, remoteItems, outcome);
      try {
        const items = await repo.listItems({ activeOnly: false });
        const byExternal = new Map(items.map((i) => [externalIdOf(i.id), i.id]));
        const byProduct = new Map(items.filter((i) => i.remoteProductId !== null).map((i) => [i.remoteProductId as string, i.id]));
        const photos = await syncPhotos(
          repo,
          connector,
          remoteItems,
          (externalId, productId) => byExternal.get(externalId) ?? byProduct.get(productId) ?? null,
        );
        if (photos.pulled > 0) outcome.pulledPhotos = photos.pulled;
        outcome.problems.push(...photos.problems);
      } catch (err) {
        outcome.problems.push(`photos: ${message(err)}`);
      }
    }
    const links = toLinks(remoteItems);
    await saveRemoteSeen(links, now, repo);
    await repo.recordRemoteCatalog(links);
  } catch (err) {
    outcome.problems.push(`catalog read: ${message(err)}`);
  }
}

/**
 * A price or name edited on MyTownCart comes here, but only when this app has
 * not changed it since the last look (so a local edit is never overwritten; it
 * is pushed instead by the catalog step). The last look is `item.remoteHash`
 * ("price:stock:active:name"); with no recorded name there is nothing to compare.
 */
async function pullFromRemote(
  repo: BillingRepository,
  remote: readonly RemoteItem[],
  outcome: SyncOutcome,
): Promise<void> {
  const byExternal = new Map(remote.map((r) => [r.externalId, r]));
  const priceFixes: ReconcileFix[] = [];
  const renames: Item[] = [];
  const renamedTo = new Map<number, string>();
  const descBaseline = await loadDescBaseline(repo);
  const nextBaseline: DescBaseline = {};
  const describedAs = new Map<number, string>();
  for (const item of await repo.listItems({ activeOnly: false })) {
    const r =
      byExternal.get(externalIdOf(item.id)) ??
      (item.remoteProductId === null ? undefined : byExternal.get(item.remoteProductId));
    if (!r) continue;
    const remoteDesc = r.description;
    if (remoteDesc !== undefined) {
      const localFp = descriptionFingerprint(item.description ?? "");
      const remoteFp = descriptionFingerprint(remoteDesc);
      const seen = descBaseline[r.externalId];
      // Changed on MyTownCart since the last look, untouched here → take theirs.
      // Changed in both places → this app wins and pushes (the content hash differs).
      if (seen !== undefined && seen.r !== remoteFp && seen.l === localFp) {
        describedAs.set(item.id, remoteDesc);
        nextBaseline[r.externalId] = { l: remoteFp, r: remoteFp };
      } else if (seen !== undefined && seen.l !== localFp && localFp === descriptionFingerprint("") && seen.r === remoteFp) {
        // Cleared here and not yet pushed: keep the baseline so the clear is retried.
        nextBaseline[r.externalId] = seen;
      } else {
        nextBaseline[r.externalId] = { l: localFp, r: remoteFp };
      }
    }
    if (item.remoteHash === null) continue;
    const parts = item.remoteHash.split(":");
    const before = Number(parts[0]);
    // Remote changed since last look; local unchanged since then → take the remote value.
    if (Number.isFinite(before) && r.pricePaise !== before && item.pricePaise === before && r.pricePaise > 0) {
      priceFixes.push({
        itemId: item.id,
        externalId: r.externalId,
        kind: "price",
        pricePaise: r.pricePaise,
        pullToLocal: true,
      });
    }
    const nameBefore = parts.length >= 4 ? parts.slice(3).join(":") : null;
    const nameNow = (r.name ?? "").trim();
    if (nameBefore !== null && nameNow !== "" && nameNow !== nameBefore && item.name === nameBefore) {
      renames.push(item);
      renamedTo.set(item.id, nameNow);
    }
  }
  if (priceFixes.length > 0) {
    await repo.applyReconcileFixes(priceFixes);
    outcome.pulledPrices = priceFixes.length;
  }
  for (const item of renames) {
    await repo.upsertItem({
      id: item.id,
      name: renamedTo.get(item.id) ?? item.name,
      barcode: item.barcode,
      categoryId: item.categoryId,
      unitKind: item.unitKind,
      pricePaise: item.pricePaise,
      mrpPaise: item.mrpPaise,
      taxRateBp: item.taxRateBp,
      openingStockMilli: 0,
      isActive: item.isActive,
      hsnCode: item.hsnCode,
      costPricePaise: item.costPricePaise,
      description: item.description,
      brand: item.brand,
      customAttributes: item.customAttributes,
    });
  }
  if (renames.length > 0) outcome.pulledNames = renames.length;

  // Pull descriptions (rich-text HTML, as stored on MyTownCart). A name rename
  // above wrote the whole item, so re-read to avoid overwriting it.
  if (describedAs.size > 0) {
    for (const item of await repo.listItems({ activeOnly: false })) {
      const html = describedAs.get(item.id);
      if (html === undefined) continue;
      await repo.upsertItem({
        id: item.id,
        name: item.name,
        barcode: item.barcode,
        categoryId: item.categoryId,
        unitKind: item.unitKind,
        pricePaise: item.pricePaise,
        mrpPaise: item.mrpPaise,
        taxRateBp: item.taxRateBp,
        openingStockMilli: 0,
        isActive: item.isActive,
        hsnCode: item.hsnCode,
        costPricePaise: item.costPricePaise,
        description: html,
        brand: item.brand,
        customAttributes: item.customAttributes,
      });
    }
    outcome.pulledDescriptions = describedAs.size;
  }
  if (remote.some((r) => r.description !== undefined)) await saveDescBaseline(repo, nextBaseline);
}

/** What each side's description looked like at the last look: fingerprints, never the text. */
type DescBaseline = Record<string, { l: string; r: string }>;
const DESC_BASELINE_KEY = "sync.desc_baseline";

async function loadDescBaseline(repo: BillingRepository): Promise<DescBaseline> {
  try {
    return JSON.parse((await repo.getAppSetting(DESC_BASELINE_KEY)) ?? "{}") as DescBaseline;
  } catch {
    return {};
  }
}

async function saveDescBaseline(repo: BillingRepository, baseline: DescBaseline): Promise<void> {
  await repo.setAppSetting(DESC_BASELINE_KEY, JSON.stringify(baseline));
}

const PULL_SKIP_KEY = "sync.pull_skip";

/**
 * Products made on MyTownCart become local items, linked so later syncs update
 * them. A product whose link failed is remembered and left for the manual Pull
 * button, so one bad product cannot create a new local item on every run.
 */
async function autoPullNew(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  outcome: SyncOutcome,
): Promise<void> {
  try {
    const snapshot = await loadPlatformOnly();
    if (snapshot === null) return;
    let skip: string[] = [];
    try {
      skip = JSON.parse((await repo.getAppSetting(PULL_SKIP_KEY)) ?? "[]") as string[];
    } catch {
      skip = [];
    }
    const todo = snapshot.items.filter((p) => !skip.includes(p.productId) && p.variantId !== null);
    if (todo.length === 0) return;
    const result = await pullPlatformProducts(repo, connector, todo, await connector.listCategories());
    if (result.pulled.length > 0) {
      await removeFromPlatformOnly(result.pulled);
      outcome.pulledItems = result.pulled.length;
    }
    if (result.failed.length > 0) {
      const failedIds = todo.filter((p) => result.failed.some((f) => f.name === p.name)).map((p) => p.productId);
      await repo.setAppSetting(PULL_SKIP_KEY, JSON.stringify([...skip, ...failedIds]));
      for (const f of result.failed) outcome.problems.push(`pull ${f.name}: ${f.error}`);
    }
  } catch (err) {
    outcome.problems.push(`pull: ${message(err)}`);
  }
}

async function recordPlatformOnly(
  connector: MarketplaceConnector,
  now: Date,
  outcome: SyncOutcome,
): Promise<void> {
  try {
    await savePlatformOnly(await connector.listPlatformProducts(), now);
  } catch (err) {
    outcome.problems.push(`platform read: ${message(err)}`);
  }
}

/** Differences from the last usable snapshot, or null when no snapshot is available. */
export async function getReconcileSnapshot(
  repo: BillingRepository,
  now: Date = new Date(),
): Promise<ReconcileRow[] | null> {
  const seen = await loadRemoteSeen(now, repo);
  if (seen === null) return null;
  const items = await repo.listItems({ activeOnly: false });
  const remote = new Map<string, RemoteItemRef>();
  // remoteHash is "price:stock:active:name"; a snapshot without it counts as active.
  for (const link of seen.values()) {
    remote.set(link.externalId, { ...link, isActive: link.remoteHash.split(":")[2] !== "0" });
  }
  const rows = reconcile(
    items.map(
      (item): ReconcileInput => ({
        itemId: item.id,
        name: item.name,
        stockMilli: item.stockMilli,
        pricePaise: item.pricePaise,
        remoteProductId: item.remoteProductId,
        isActive: item.isActive,
      }),
    ),
    remote,
  );
  // A clamped/rejected delivery still needs an explicit decision when the two
  // displayed quantities happen to match. Do not hide it as already synced.
  const blocked = new Set(activeStockSources(await repo.listOutbox("quarantined"), await repo.listStockSourceResolutions()).map((entry) => entry.externalId));
  for (const intent of await repo.listStockReconciliations()) {
    if (intent.status === "conflict") blocked.add(intent.externalId);
  }
  for (const item of items) {
    const externalId = externalIdOf(item.id);
    const seenItem = remote.get(externalId);
    if (!blocked.has(externalId) || !seenItem || rows.some((row) => row.itemId === item.id && row.kind === "stock")) continue;
    rows.push({ itemId: item.id, externalId, name: item.name, kind: "stock", localValue: stockUnitsOf(item.stockMilli) ?? 0, remoteValue: seenItem.stockUnits });
  }
  return rows;
}

/** Compatibility for callers that do not yet display the unavailable state. */
export async function listReconcileRows(
  repo: BillingRepository,
  now: Date = new Date(),
): Promise<ReconcileRow[]> {
  return (await getReconcileSnapshot(repo, now)) ?? [];
}

/** Background sync is available in Tauri desktop app or connected LAN server. */
export function syncAvailable(): boolean {
  return isInTauri() || isLanServer();
}

export { remoteHashOf };
