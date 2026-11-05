// SPDX-License-Identifier: Apache-2.0
/**
 * Two-way sync planning (B5, roadmap §8.6): what to push, how long to wait
 * before the next attempt, and which local vs marketplace differences the
 * seller must settle. All pure — the storage adapters and UI only carry out
 * these decisions.
 */

import { contentHash, externalIdOf, stockUnitsOf, type PublishItemInput } from "./publish";

export interface OutboxMove {
  id: number;
  idempotencyKey: string;
  externalId: string;
  deltaUnits: number;
  reason: "sale" | "adjustment" | "order_cancel";
  attempts: number;
  nextAttemptAt: string | null;
}

/** Movements the marketplace can accept right now (nothing scheduled later). */
export function dueMovements(moves: readonly OutboxMove[], now: Date): OutboxMove[] {
  const stamp = now.toISOString();
  return moves.filter((m) => m.nextAttemptAt === null || m.nextAttemptAt <= stamp);
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/** 30 s, 1 m, 2 m, 4 m … capped at 30 min (the outbox never gives up by itself). */
export function backoffMs(attempts: number): number {
  const n = Math.max(0, Math.min(attempts, 10));
  return Math.min(BACKOFF_BASE_MS * 2 ** n, BACKOFF_MAX_MS);
}

export function nextAttemptAt(attempts: number, now: Date): string {
  return new Date(now.getTime() + backoffMs(attempts)).toISOString();
}

/** One push batch: the server caps how much it accepts per call. */
export function chunkMoves<T>(moves: readonly T[], max: number): T[][] {
  const size = Math.max(1, max);
  const out: T[][] = [];
  for (let i = 0; i < moves.length; i += size) out.push(moves.slice(i, i + size));
  return out;
}

/**
 * Fingerprint of what the marketplace would hold after a catalog push. The
 * planner only emits ready items, where the category is always mapped.
 */
export function remoteHashOf(input: PublishItemInput): string | null {
  if (input.marketplaceCategoryId === null) return null;
  return contentHash({
    name: input.name,
    pricePaise: input.pricePaise,
    mrpPaise: input.mrpPaise,
    stockMilli: input.stockMilli,
    barcode: input.barcode,
    marketplaceCategoryId: input.marketplaceCategoryId,
    isActive: input.isActive,
  });
}

/** Items that are linked to the marketplace but need a catalog update. */
export function needsCatalogPush(input: PublishItemInput): boolean {
  if (input.lastPublishedHash === null) return false;
  return input.lastPublishedHash !== remoteHashOf(input);
}

export type ReconcileKind = "stock" | "price" | "missing_remote" | "remote_inactive";

export interface ReconcileRow {
  itemId: number;
  name: string;
  externalId: string;
  kind: ReconcileKind;
  localValue: number | null;
  remoteValue: number | null;
}

export interface ReconcileInput {
  itemId: number;
  name: string;
  stockMilli: number;
  pricePaise: number;
  remoteProductId: string | null;
  isActive: boolean;
}

export interface RemoteItemRef {
  externalId: string;
  stockUnits: number;
  pricePaise: number;
  isActive: boolean;
}

/**
 * What differs between the till and the marketplace for items that were
 * published. `remote` is keyed by the `itm_<id>` external id. The seller
 * resolves each row in the UI (default: local wins, BR5).
 */
export function reconcile(
  local: readonly ReconcileInput[],
  remote: ReadonlyMap<string, RemoteItemRef>,
): ReconcileRow[] {
  const rows: ReconcileRow[] = [];
  for (const item of local) {
    if (item.remoteProductId === null) continue;
    const externalId = externalIdOf(item.itemId);
    const remoteItem = remote.get(externalId);
    if (!remoteItem) {
      rows.push({
        itemId: item.itemId,
        name: item.name,
        externalId,
        kind: "missing_remote",
        localValue: item.stockMilli,
        remoteValue: null,
      });
      continue;
    }
    if (!item.isActive && remoteItem.isActive) {
      rows.push({
        itemId: item.itemId,
        name: item.name,
        externalId,
        kind: "remote_inactive",
        localValue: 0,
        remoteValue: 1,
      });
    }
    const localUnits = stockUnitsOf(item.stockMilli);
    if (localUnits !== null && localUnits !== remoteItem.stockUnits) {
      rows.push({
        itemId: item.itemId,
        name: item.name,
        externalId,
        kind: "stock",
        localValue: localUnits,
        remoteValue: remoteItem.stockUnits,
      });
    }
    if (item.pricePaise !== remoteItem.pricePaise) {
      rows.push({
        itemId: item.itemId,
        name: item.name,
        externalId,
        kind: "price",
        localValue: item.pricePaise,
        remoteValue: remoteItem.pricePaise,
      });
    }
  }
  return rows;
}

/** Local quantity is short of the bill about to be printed. */
export function insufficientStock(
  lines: readonly { itemId: number; qtyMilli: number }[],
  stockByItem: ReadonlyMap<number, number>,
): { itemId: number; wantedMilli: number; availableMilli: number }[] {
  return lines.flatMap((l) => {
    const available = stockByItem.get(l.itemId);
    if (available === undefined || available >= l.qtyMilli) return [];
    return [{ itemId: l.itemId, wantedMilli: l.qtyMilli, availableMilli: available }];
  });
}
