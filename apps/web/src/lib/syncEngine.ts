// SPDX-License-Identifier: Apache-2.0
/**
 * B5 two-way sync (roadmap §8.6), driven from MyTownCart → Sync.
 *
 * - push: the outbox (stock deltas written in the same transaction as each
 *   sale/adjustment) is sent in server-sized batches. Each run merges the
 *   pending deltas per item into ONE net movement with its own idempotency
 *   key, so "sell 1 five times" never clamps in between. Failures back off
 *   exponentially and are never dropped.
 * - catalog: price/other edits and the merged restock ride on a catalog
 *   upsert; the per-item content hash decides what is actually sent.
 * - pull: the remote stock feed advances `stock_cursor` in the same
 *   transaction as the applied moves, so a crash can neither replay nor
 *   skip a page.
 * - snapshot: the marketplace's current values are cached for the reconcile
 *   view and the read-only online orders list.
 */
import type {
  MarketplaceConnector,
  RemoteItem,
} from "@mytowncart-billing/connector-mytowncart";
import {
  externalIdOf,
  planPublish,
  reconcile,
  remoteHashOf,
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
  OutboxRow,
  RemoteItemLink,
} from "@mytowncart-billing/storage";

import { isInTauri } from "./repository";
import { loadRemoteSeen, saveRemoteSeen } from "./remoteSeen";

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
  orders: number;
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
  }));
}

/** Net delta per external id for one run (sales negative, restocks positive). */
export function netDeltas(rows: readonly OutboxRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    // Rows record the signed change to local stock, which mirrors the remote.
    out.set(row.externalId, (out.get(row.externalId) ?? 0) + row.deltaUnits);
  }
  return out;
}

function newKey(externalId: string, now: Date): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${externalId}:merge:${now.getTime()}:${random}`;
}

export async function runSync(
  deps: SyncDeps,
  options: { bulkMax?: number } = {},
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
    orders: 0,
    problems: [],
  };

  const pending = await repo.listOutbox("pending");
  const bulkMax = Math.min(Math.max(1, options.bulkMax ?? DEFAULT_BULK_MAX), DEFAULT_BULK_MAX);
  const deltas = await pushStock(repo, connector, pending, now, outcome, bulkMax);
  await pushCatalog(repo, connector, deltas, outcome);
  await pullStock(repo, connector, outcome);
  await recordSnapshot(repo, connector, now, outcome);
  await pullOrders(repo, connector, now, outcome);
  return outcome;
}

/** Pushes merged deltas; returns the deltas the marketplace accepted. */
async function pushStock(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  pending: readonly OutboxRow[],
  now: Date,
  outcome: SyncOutcome,
  bulkMax: number,
): Promise<Map<string, number>> {
  const accepted = new Map<string, number>();
  const deltas = [...netDeltas(pending)].filter(([, delta]) => delta !== 0);
  if (deltas.length === 0) {
    // Nothing to send, but zero-sum rows are settled too.
    const keys = pending.map((r) => r.idempotencyKey);
    if (keys.length > 0) await repo.dropOutbox(keys);
    return accepted;
  }

  const batches: [string, number][][] = [];
  for (let i = 0; i < deltas.length; i += bulkMax) batches.push(deltas.slice(i, i + bulkMax));

  const okExternal = new Set<string>();
  const retryAttempts = new Map<string, number>();
  for (const batch of batches) {
    const moves = batch.map(([externalId, deltaUnits]) => ({
      externalId,
      deltaUnits,
      reason: deltaUnits < 0 ? ("sale" as const) : ("adjustment" as const),
      idempotencyKey: newKey(externalId, now),
      createdAt: now.toISOString(),
    }));
    try {
      const results = await connector.pushStock(moves);
      const byKey = new Map(results.map((r) => [r.idempotencyKey, r]));
      for (const move of moves) {
        const result = byKey.get(move.idempotencyKey);
        if (result && (result.status === "applied" || result.status === "duplicate")) {
          okExternal.add(move.externalId);
          accepted.set(move.externalId, move.deltaUnits);
          outcome.pushedMoves += 1;
        } else {
          // A rejected move (unknown item, bad data) would be rejected again;
          // count it, and let the backoff line below keep it visible.
          const attempts = (retryAttempts.get(move.externalId) ?? 0) + 1;
          retryAttempts.set(move.externalId, attempts);
          outcome.problems.push(`${move.externalId}: ${result?.error ?? "rejected"}`);
        }
      }
    } catch (err) {
      outcome.problems.push(`stock push: ${message(err)}`);
      for (const move of moves) retryAttempts.set(move.externalId, (retryAttempts.get(move.externalId) ?? 0) + 1);
    }
  }

  // Settle what went through; schedule the rest.
  const done = pending.filter((r) => okExternal.has(r.externalId)).map((r) => r.idempotencyKey);
  if (done.length > 0) await repo.dropOutbox(done);

  const retrying = pending.filter((r) => !okExternal.has(r.externalId));
  const updates = retrying
    .filter((r) => (retryAttempts.get(r.externalId) ?? 0) > 0)
    .map((r) => {
      const attempts = Math.min(r.attempts + 1, MAX_ATTEMPTS_WITH_BACKOFF);
      const delay = Math.min(30_000 * 2 ** attempts, 30 * 60_000);
      return {
        idempotencyKey: r.idempotencyKey,
        outcome: "retry" as const,
        nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
      };
    });
  if (updates.length > 0) await repo.recordOutboxResults(updates);
  return accepted;
}

async function pushCatalog(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  restock: ReadonlyMap<string, number>,
  outcome: SyncOutcome,
): Promise<void> {
  const [items, categories, marketplace] = await Promise.all([
    repo.listItems({ activeOnly: false }),
    repo.listCategories(),
    connector.listCategories(),
  ]);
  if (marketplace.length === 0) return;

  // The marketplace already holds the restocked quantity; reflect it locally
  // so the hash below describes the same state and no duplicate is sent.
  const itemsWithRestock = items.map((item) => {
    const delta = restock.get(externalIdOf(item.id));
    if (delta === undefined) return item;
    return { ...item, stockMilli: Math.max(0, item.stockMilli + delta * 1000) };
  });

  const plan = planPublish(toPlanInputs(itemsWithRestock, categories), marketplace);
  // Items the seller unpublished locally are sent as inactive, not skipped.
  const changed = plan.ready.filter(
    (r) => r.input.lastPublishedHash === null || r.input.lastPublishedHash !== r.hash,
  );
  if (changed.length === 0) return;

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
      })),
    );
    const byExternal = new Map(results.map((r) => [r.externalId, r]));
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
    outcome.restocked = changed.filter((r) => restock.has(r.externalId) && r.input.lastPublishedHash !== null).length;
  } catch (err) {
    outcome.problems.push(`catalog: ${message(err)}`);
  }
}

async function pullStock(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  outcome: SyncOutcome,
): Promise<void> {
  const stored = Number((await repo.getSyncCursor("stock")) ?? "0");
  let cursor = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
  try {
    for (let page = 0; page < PULL_PAGE_CAP; page++) {
      const feed = await connector.pullStock(cursor);
      if (feed.nextCursor === cursor && feed.moves.length === 0) break;
      const applied = await repo.applyStockPull(
        String(feed.nextCursor),
        feed.moves.map((m) => ({
          externalId: m.externalId,
          deltaUnits: m.deltaUnits,
          reason: m.reason,
          createdAt: m.createdAt,
        })),
      );
      outcome.pulledMoves += applied.filter((a) => a.itemId !== null).length;
      if (feed.nextCursor === cursor) break;
      cursor = feed.nextCursor;
    }
  } catch (err) {
    outcome.problems.push(`stock pull: ${message(err)}`);
  }
}

function toLinks(remote: readonly RemoteItem[]): RemoteItemLink[] {
  return remote.map((r) => ({
    externalId: r.externalId,
    stockUnits: r.stockUnits,
    pricePaise: r.pricePaise,
    remoteHash: "",
  }));
}

async function recordSnapshot(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  now: Date,
  outcome: SyncOutcome,
): Promise<void> {
  try {
    const links = toLinks(await connector.listRemoteItems());
    await saveRemoteSeen(links, now);
    await repo.recordRemoteCatalog(links);
  } catch (err) {
    outcome.problems.push(`catalog read: ${message(err)}`);
  }
}

async function pullOrders(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  now: Date,
  outcome: SyncOutcome,
): Promise<void> {
  try {
    const after = await repo.getSyncCursor("orders");
    const page = await connector.pullOrders(after ?? undefined);
    outcome.orders = await repo.recordRemoteOrders(
      page.orders.map((o) => ({
        id: o.id,
        status: o.status,
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod,
        totalPaise: o.totalPaise,
        placedAt: o.placedAt,
        updatedAt: o.updatedAt,
        lines: o.lines.map((l) => ({
          externalId: l.externalId,
          productName: l.productName,
          qtyUnits: l.qtyUnits,
          unitPricePaise: l.unitPricePaise,
        })),
        syncedAt: now.toISOString(),
      })),
    );
    if (page.next) await repo.setSyncCursor("orders", page.next);
  } catch (err) {
    outcome.problems.push(`orders: ${message(err)}`);
  }
}

/** Differences for the reconcile view, from the last snapshot. */
export async function listReconcileRows(
  repo: BillingRepository,
  now: Date = new Date(),
): Promise<ReconcileRow[]> {
  const [items, seen] = await Promise.all([repo.listItems({ activeOnly: false }), loadRemoteSeen(now)]);
  const remote = new Map<string, RemoteItemRef>();
  for (const link of seen.values()) remote.set(link.externalId, { ...link, isActive: true });
  return reconcile(
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
}

/** Only the desktop shell runs background sync; the browser demo stays local. */
export function syncAvailable(): boolean {
  return isInTauri();
}

export { remoteHashOf };
