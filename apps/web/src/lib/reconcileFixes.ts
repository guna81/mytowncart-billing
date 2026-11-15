// SPDX-License-Identifier: Apache-2.0
import { reconcile, type ReconcileRow } from "@mytowncart-billing/core";
import { MarketplaceError, type MarketplaceConnector } from "@mytowncart-billing/connector-mytowncart";
import type { BillingRepository, ReconcileFix, StockProtocolState, StockReconciliationIntent, OutboxRow, StockSourceResolution } from "@mytowncart-billing/storage";
import { loadRemoteSeen } from "./remoteSeen";

/** Render-time equality prevents refreshed evidence from inheriting older consent. */
export function stockRecoveryConsentMatches(confirmedSnapshot: string | null, reviewedSnapshot: string): boolean {
  return confirmedSnapshot !== null && confirmedSnapshot === reviewedSnapshot;
}

export function exceptionalStockSourceEligible(source: OutboxRow): boolean {
  if (source.status !== "quarantined" || source.rawPayloadJson === undefined) return false;
  try {
    const payload: unknown = JSON.parse(source.rawPayloadJson);
    const id = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>).externalId : undefined;
    return typeof id !== "string" || id.length === 0;
  } catch { return true; }
}

export function activeStockSources(sources: readonly OutboxRow[], history: readonly StockSourceResolution[]): OutboxRow[] {
  return sources.filter((source) => !history.some((entry) => entry.sourceId === source.id && (entry.action === "historical_unknown" || !!entry.retiredBy))).map((source) => {
    const mapping = history.find((entry) => entry.sourceId === source.id && entry.action === "map" && !entry.retiredBy);
    return mapping ? { ...source, externalId: mapping.externalId ?? `itm_${mapping.itemId}` } : source;
  });
}

/** Re-read both sides immediately before applying a decision. This is a guard,
 * not a distributed lock: either side can still change after the checks. */
export async function validateReconcileTargets(
  targets: readonly ReconcileRow[], repo: BillingRepository, connector: MarketplaceConnector,
  displayedRows: readonly ReconcileRow[] = targets,
): Promise<void> {
  const stale = () => new Error("Reconciliation has changed. Run Sync now and review the differences again.");
  const seen = await loadRemoteSeen(new Date(), repo);
  if (seen === null) throw stale();
  const remoteItems = await connector.listRemoteItems();
  const remote = new Map(remoteItems.map((item) => [item.externalId, item]));
  // Duplicate IDs make the result ambiguous; never choose an arbitrary entry.
  if (remote.size !== remoteItems.length) throw stale();
  for (const id of new Set(targets.map((row) => row.externalId))) {
    const old = seen.get(id);
    const current = remote.get(id);
    if (!old !== !current || (old && current && (
      old.pricePaise !== current.pricePaise || old.stockUnits !== current.stockUnits ||
      (old.remoteHash.split(":")[2] !== "0") !== current.isActive
    ))) throw stale();
  }
  const items = await repo.listItems({ activeOnly: false });
  const currentRows = reconcile(items.map((item) => ({
    itemId: item.id, name: item.name, stockMilli: item.stockMilli,
    pricePaise: item.pricePaise, remoteProductId: item.remoteProductId, isActive: item.isActive,
  })), remote);
  for (const target of targets) {
    if (target.kind !== "stock" || currentRows.some((row) => row.itemId === target.itemId && row.kind === "stock")) continue;
    const local = items.find((item) => item.id === target.itemId);
    const marketplace = remote.get(target.externalId);
    if (local && marketplace && local.stockMilli === (target.localValue ?? -1) * 1000 && marketplace.stockUnits === target.remoteValue) {
      currentRows.push({ ...target });
    }
  }
  const ids = new Set(targets.map((row) => row.itemId));
  const before = displayedRows.filter((row) => ids.has(row.itemId));
  const after = currentRows.filter((row) => ids.has(row.itemId));
  const same = (a: ReconcileRow, b: ReconcileRow) => a.itemId === b.itemId &&
    a.externalId === b.externalId && a.kind === b.kind &&
    a.localValue === b.localValue && a.remoteValue === b.remoteValue;
  if (before.length !== after.length || before.some((row) => !after.some((candidate) => same(row, candidate))) ||
      targets.some((row) => !before.some((candidate) => same(row, candidate)))) throw stale();
}

function requireStockProtocol(connector: MarketplaceConnector): void {
  if (!connector.stockSnapshot || !connector.reconcileStock || !connector.stockReconciliation) {
    throw new Error("Marketplace does not support safe stock reconciliation");
  }
}

function protocolState(item: { externalId: string; variantId: string; stockUnits: number; revision: number; generation: number }, epoch: string, sequence: number): StockProtocolState {
  if (!item.variantId) throw new Error("Invalid marketplace stock identity");
  return { ...item, epoch, sequence };
}

async function recoverIntent(repo: BillingRepository, connector: MarketplaceConnector, intent: StockReconciliationIntent): Promise<StockReconciliationIntent> {
  if (!connector.stockReconciliation || !connector.reconcileStock) throw new Error("Marketplace does not support safe stock reconciliation");
  // Query before retrying: an accepted operation with a lost response must use
  // its original result, not a new snapshot or a fresh operation key.
  let result;
  try {
    result = await connector.stockReconciliation(intent.operationId) ?? await connector.reconcileStock({
      operationId: intent.operationId, externalId: intent.externalId,
      variantId: intent.variantId, epoch: intent.epoch,
      expectedRevision: intent.revision, generation: intent.generation, quantity: intent.stockUnits,
    });
  } catch (error) {
    if (error instanceof MarketplaceError && error.status === 409) {
      await repo.rejectStockReconciliation(intent.operationId, error.message);
    }
    throw error;
  }
  if (result.operationId !== intent.operationId || result.externalId !== intent.externalId ||
      result.variantId !== intent.variantId || result.epoch !== intent.epoch ||
      result.stockUnits !== intent.stockUnits || result.generation !== intent.generation + 1) {
    throw new Error("Marketplace reconciliation result identity mismatch");
  }
  return repo.settleStockReconciliation(intent.operationId, protocolState(result, result.epoch, result.watermark));
}

export async function recoverStockReconciliations(repo: BillingRepository, connector: MarketplaceConnector): Promise<void> {
  // Bounded recovery; storage blocks conflicting deliveries while uncertain.
  const journal = await repo.listStockReconciliations();
  for (const intent of journal.filter((entry) => entry.status === "pending" && !journal.some((child) => child.parentOperationId === entry.operationId && child.status !== "conflict")).slice(0, 100)) {
    await recoverIntent(repo, connector, intent);
  }
}

/** A mapped malformed source is never retried: resolve via a captured conditional baseline. */
export async function reconcileMappedSource(
  repo: BillingRepository, connector: MarketplaceConnector,
  decision: { itemId: number; expectedLocalStockMilli: number; confirmed: boolean; reason: string },
): Promise<StockReconciliationIntent> {
  if (!decision.confirmed || !decision.reason.trim()) throw new Error("Confirmation and reason are required");
  requireStockProtocol(connector);
  await recoverStockReconciliations(repo, connector);
  const unresolved = (await repo.listStockSourceResolutions()).some((entry) => entry.action === "map" && !entry.retiredBy && entry.itemId === decision.itemId);
  if (!unresolved) throw new Error("Mapped source is already resolved");
  const externalId = `itm_${decision.itemId}`;
  const activeEpoch = await repo.getAppSetting("sync.stock_epoch");
  if (!activeEpoch) await repo.setAppSetting("sync.stock_bootstrap_required", "true");
  const snapshot = await connector.stockSnapshot!([externalId]);
  if (activeEpoch !== snapshot.epoch) await repo.setAppSetting("sync.stock_bootstrap_required", "true");
  if (snapshot.items.length !== 1 || snapshot.items[0]?.externalId !== externalId) throw new Error("Marketplace stock identity changed");
  const intent = await repo.beginStockReconciliation({
    ...protocolState(snapshot.items[0], snapshot.epoch, snapshot.watermark), operationId: crypto.randomUUID(),
    itemId: decision.itemId, choice: "local", stockUnits: decision.expectedLocalStockMilli / 1000, expectedLocalStockMilli: decision.expectedLocalStockMilli,
  });
  return recoverIntent(repo, connector, intent);
}

/** Recover durable work before creating a fresh, explicitly confirmed zero baseline.
 * The displayed local stock is a CAS token, never silently refreshed for consent. */
export async function recoverStockShortage(
  repo: BillingRepository, connector: MarketplaceConnector,
  decision: { parentOperationId: string; expectedLocalStockMilli: number; reason: string; confirmed: boolean },
): Promise<StockReconciliationIntent> {
  if (!decision.confirmed || !decision.reason.trim()) throw new Error("Confirmation and reason are required");
  requireStockProtocol(connector);
  await recoverStockReconciliations(repo, connector);
  const intents = await repo.listStockReconciliations();
  const parent = intents.find((entry) => entry.operationId === decision.parentOperationId);
  if (!parent) throw new Error("Stock recovery operation not found");
  // A prior click/restart may already have created the child. Never rekey it.
  const child = intents.find((entry) => entry.parentOperationId === parent.operationId && entry.status !== "conflict");
  if (child) return child;
  if (parent.status !== "needs_review" || !parent.result || !parent.review) throw new Error("Stock recovery is no longer required");
  const local = (await repo.listItems({ activeOnly: false })).find((item) => item.id === parent.itemId);
  if (!local || local.stockMilli !== decision.expectedLocalStockMilli) throw new Error("Local stock changed. Review the recovery again.");
  const snapshot = await connector.stockSnapshot!([parent.externalId]);
  if (snapshot.items.length !== 1 || snapshot.items[0]?.externalId !== parent.externalId || snapshot.items[0].variantId !== parent.variantId) {
    throw new Error("Marketplace stock identity changed");
  }
  const intent = await repo.beginStockRecovery({
    ...protocolState(snapshot.items[0], snapshot.epoch, snapshot.watermark),
    operationId: crypto.randomUUID(), parentOperationId: parent.operationId,
    itemId: parent.itemId, choice: "remote", stockUnits: 0,
    expectedLocalStockMilli: decision.expectedLocalStockMilli, reason: decision.reason.trim(),
  });
  return recoverIntent(repo, connector, intent);
}

/** Explicit all-linked bootstrap. Completed item baselines survive interruption. */
export async function bootstrapStock(
  repo: BillingRepository, connector: MarketplaceConnector, pull: boolean,
): Promise<void> {
  requireStockProtocol(connector);
  await repo.setAppSetting("sync.stock_bootstrap_required", "true");
  await recoverStockReconciliations(repo, connector);
  // Linked = has a marketplace id. A bare content hash (local_only items) is not a link;
  // the marketplace rejects the whole snapshot batch with unknown_item for such an item.
  const items = (await repo.listItems({ activeOnly: false })).filter((item) => item.remoteProductId !== null || item.remoteVariantId !== null);
  let epoch: string | null = null;
  const completed = new Map((await repo.listStockProtocolStates()).map((state) => [state.externalId, state]));
  for (let index = 0; index < items.length; index += 200) {
    const batch = items.slice(index, index + 200);
    const ids = batch.map((item) => `itm_${item.id}`);
    const snapshot = await connector.stockSnapshot!(ids);
    if (epoch && snapshot.epoch !== epoch) throw new Error("Marketplace stock epoch changed during bootstrap; retry");
    epoch = snapshot.epoch;
    const remote = new Map(snapshot.items.map((item) => [item.externalId, item]));
    if (remote.size !== snapshot.items.length) throw new Error("Ambiguous marketplace stock snapshot");
    for (const item of batch) {
      const externalId = `itm_${item.id}`;
      const stock = remote.get(externalId);
      if (!stock) throw new Error(`Marketplace stock item missing: ${item.name}`);
      const done = completed.get(externalId);
      if (done?.epoch === epoch && done.variantId === stock.variantId) continue;
      if (!Number.isSafeInteger(item.stockMilli / 1000)) throw new Error(`Stock must be whole units: ${item.name}`);
      const intent = await repo.beginStockReconciliation({
        ...protocolState(stock, epoch, snapshot.watermark), operationId: crypto.randomUUID(),
        itemId: item.id, choice: pull ? "remote" : "local",
        stockUnits: pull ? stock.stockUnits : item.stockMilli / 1000,
        expectedLocalStockMilli: item.stockMilli,
      });
      const settled = await recoverIntent(repo, connector, intent);
      if (settled.status === "needs_review") throw new Error("Marketplace decision committed; local shortage requires explicit stock recovery review.");
    }
  }
  if (!epoch) throw new Error("No linked stock items to bootstrap");
  await repo.activateStockEpoch(epoch);
}

/** Stock decisions never pass through catalog hashes or ordinary local sets. */
export async function applyReconciliation(
  targets: readonly ReconcileRow[], pull: boolean, repo: BillingRepository, connector: MarketplaceConnector,
): Promise<void> {
  const stock = targets.filter((row) => row.kind === "stock");
  if (stock.length) {
    requireStockProtocol(connector);
    await recoverStockReconciliations(repo, connector);
    const ids = [...new Set(stock.map((row) => row.externalId))];
    if (ids.length > 200) throw new Error("Select at most 200 stock items per reconciliation");
    const activeEpoch = await repo.getAppSetting("sync.stock_epoch");
    if (!activeEpoch) await repo.setAppSetting("sync.stock_bootstrap_required", "true");
    const snapshot = await connector.stockSnapshot!(ids);
    if (activeEpoch !== snapshot.epoch) await repo.setAppSetting("sync.stock_bootstrap_required", "true");
    const byId = new Map(snapshot.items.map((item) => [item.externalId, item]));
    if (byId.size !== snapshot.items.length) throw new Error("Ambiguous marketplace stock snapshot");
    for (const row of stock) {
      const item = byId.get(row.externalId);
      if (!item || item.stockUnits !== row.remoteValue || row.localValue === null) {
        throw new Error("Stock changed. Run Sync now and review the differences again.");
      }
      const state = protocolState(item, snapshot.epoch, snapshot.watermark);
      const intent = await repo.beginStockReconciliation({
        ...state, operationId: crypto.randomUUID(), itemId: row.itemId,
        choice: pull ? "remote" : "local", stockUnits: pull ? item.stockUnits : row.localValue,
        expectedLocalStockMilli: row.localValue * 1000,
      });
      const settled = await recoverIntent(repo, connector, intent);
      if (settled.status === "needs_review") throw new Error("Marketplace decision committed; local shortage requires explicit stock recovery review.");
    }
    // A selected-item baseline is not a global feed bootstrap. Only the
    // explicit all-linked flow can activate a previously unknown epoch.
  }
  const metadata = reconcileFixes(targets.filter((row) => row.kind !== "stock"), pull);
  if (metadata.length) await repo.applyReconcileFixes(metadata);
}

/** Prepare decisions without treating absent marketplace items as local wins. */
export function reconcileFixes(rows: readonly ReconcileRow[], pull: boolean): ReconcileFix[] {
  return rows.filter((row) => !pull || row.kind !== "missing_remote").map((row) => {
    const fix: ReconcileFix = { itemId: row.itemId, externalId: row.externalId, kind: row.kind };
    if (!pull) return fix;
    const value = row.remoteValue;
    if (value === null || !Number.isSafeInteger(value) || value < 0 ||
        (row.kind === "stock" && value > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) ||
        (row.kind === "remote_inactive" && value !== 0 && value !== 1)) {
      throw new Error(`Invalid marketplace value for ${row.name}`);
    }
    fix.pullToLocal = true;
    if (row.kind === "price") fix.pricePaise = value;
    if (row.kind === "stock") fix.stockUnits = value;
    if (row.kind === "remote_inactive") fix.isActive = value === 1;
    return fix;
  });
}
