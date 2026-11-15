// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { ReconcileRow } from "@mytowncart-billing/core";
import type { MarketplaceConnector, RemoteItem } from "@mytowncart-billing/connector-mytowncart";
import type { BillingRepository } from "@mytowncart-billing/storage";
import { MemoryRepository } from "@mytowncart-billing/storage";
import { MarketplaceError } from "@mytowncart-billing/connector-mytowncart";
import { exceptionalStockSourceEligible, stockRecoveryConsentMatches, activeStockSources, applyReconciliation, bootstrapStock, recoverStockReconciliations, recoverStockShortage, reconcileMappedSource, reconcileFixes, validateReconcileTargets } from "./reconcileFixes";

const row = (kind: ReconcileRow["kind"], remoteValue: number | null): ReconcileRow => ({
  itemId: 1, name: "Item", externalId: "itm_1", kind, localValue: 5, remoteValue,
});

describe("review-bound recovery consent", () => {
  it("invalidates synchronously for local sales, new evidence, selected mapping or reason changes", () => {
    const snapshot = { sources: ["raw"], intents: ["operation"], history: [], items: [{ id: 1, stockMilli: 5000 }], itemId: "1", reason: "counted" };
    const token = JSON.stringify(snapshot);
    expect(stockRecoveryConsentMatches(token, token)).toBe(true);
    expect(stockRecoveryConsentMatches(null, token)).toBe(false);
    for (const change of [{ items: [{ id: 1, stockMilli: 4000 }] }, { sources: ["changed raw"] }, { intents: ["child"] }, { history: ["mapped"] }, { itemId: "2" }, { reason: "different reason" }]) {
      expect(stockRecoveryConsentMatches(token, JSON.stringify({ ...snapshot, ...change }))).toBe(false);
    }
  });
});

describe("exceptional source eligibility", () => {
  const source = { id: 1, idempotencyKey: "raw", externalId: "", deltaUnits: 0, reason: "sale" as const, attempts: 0, nextAttemptAt: null, status: "quarantined" as const };
  it.each(["{bad", "{}", "null", '{"externalId":null}', '{"externalId":7}', '{"externalId":""}'])("accepts only unidentified raw evidence %s", (rawPayloadJson) => {
    expect(exceptionalStockSourceEligible({ ...source, rawPayloadJson })).toBe(true);
  });
  it.each(['{"externalId":"itm_1"}', '{"externalId":"stale-id"}', '{"externalId":" "}'])("rejects any nonempty string identity %s", (rawPayloadJson) => {
    expect(exceptionalStockSourceEligible({ ...source, rawPayloadJson })).toBe(false);
  });
  it("fails closed without evidence or quarantine", () => {
    expect(exceptionalStockSourceEligible(source)).toBe(false);
    expect(exceptionalStockSourceEligible({ ...source, status: "pending", rawPayloadJson: "bad" })).toBe(false);
  });
});

describe("active source status", () => {
  it("hides historical/retired evidence but counts unresolved mapping against its verified item", () => {
    const source = (id: number) => ({ id, idempotencyKey: `key-${id}`, externalId: "", deltaUnits: 0, reason: "sale" as const, attempts: 0, nextAttemptAt: null, status: "quarantined" as const });
    const resolution = (sourceId: number, action: "map" | "historical_unknown", retiredBy?: string) => ({ operationId: `op-${sourceId}`, sourceId, idempotencyKey: `key-${sourceId}`, rawPayloadJson: "bad", action, itemId: action === "map" ? 9 : undefined, reason: "verified evidence", confirmed: true, actor: 1, createdAt: "now", retiredBy });
    expect(activeStockSources([source(1), source(2), source(3), source(4)], [resolution(1, "historical_unknown"), resolution(2, "map", "settled"), resolution(3, "map")])).toEqual([{ ...source(3), externalId: "itm_9" }, source(4)]);
  });
});

describe("reconcileFixes", () => {
  it("includes marketplace price, stock including zero, and active state", () => {
    expect(reconcileFixes([row("price", 1200), row("stock", 0), row("remote_inactive", 1)], true)).toEqual([
      { itemId: 1, externalId: "itm_1", kind: "price", pullToLocal: true, pricePaise: 1200 },
      { itemId: 1, externalId: "itm_1", kind: "stock", pullToLocal: true, stockUnits: 0 },
      { itemId: 1, externalId: "itm_1", kind: "remote_inactive", pullToLocal: true, isActive: true },
    ]);
  });
  it("leaves missing marketplace items untouched when using marketplace values", () => {
    expect(reconcileFixes([row("missing_remote", null), row("price", 7)], true)).toHaveLength(1);
    expect(reconcileFixes([row("missing_remote", null)], false)).toEqual([
      { itemId: 1, externalId: "itm_1", kind: "missing_remote" },
    ]);
  });
  it.each([null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid marketplace value %s", (value) => {
    expect(() => reconcileFixes([row("price", value)], true)).toThrow();
  });
});

describe("durable stock reconciliation active path", () => {
  async function fixture() {
    const repo = new MemoryRepository();
    const itemId = await repo.upsertItem({ name: "Item", barcode: "", categoryId: null, unitKind: "count", pricePaise: 100, mrpPaise: 100, taxRateBp: 0, openingStockMilli: 5000, isActive: true });
    await repo.recordPublish([{ itemId, state: "live", remoteProductId: "p", remoteVariantId: "variant-uuid", contentHash: "hash" }], new Map());
    const remote = { externalId: `itm_${itemId}`, variantId: "variant-uuid", stockUnits: 7, revision: 3, generation: 1 };
    const calls: unknown[] = [];
    const connector = {
      stockProtocol: async () => ({ protocol: 2, capabilities: ["committed_feed", "snapshot", "generation_fence", "conditional_reconcile", "operation_status"] }),
      enableStockProtocol: async () => ({ protocol: 2, epoch: "epoch", watermark: 10, items: [remote] }),
      stockSnapshot: async () => ({ protocol: 2, epoch: "epoch", watermark: 10, items: [remote] }),
      stockReconciliation: async () => null,
      reconcileStock: async (request: Parameters<NonNullable<MarketplaceConnector["reconcileStock"]>>[0]) => {
        calls.push(request);
        return { ...remote, operationId: request.operationId, epoch: "epoch", watermark: 11, stockUnits: request.quantity, generation: 2, revision: 4 };
      },
    } as unknown as MarketplaceConnector;
    const target = { ...row("stock", 7), itemId, externalId: remote.externalId };
    return { repo, itemId, connector, calls, target, remote };
  }

  it("recovers accepted-but-response-lost decisions and preserves a sale after capture", async () => {
    const { repo, itemId, connector, target, remote, calls } = await fixture();
    let accepted: Awaited<ReturnType<NonNullable<MarketplaceConnector["reconcileStock"]>>> | null = null;
    connector.reconcileStock = async (request) => {
      calls.push(request);
      accepted = { ...remote, operationId: request.operationId, epoch: "epoch", watermark: 11, stockUnits: request.quantity, generation: 2, revision: 4 };
      await repo.adjustStock(itemId, -1000, "adjustment");
      throw new Error("response lost");
    };
    await expect(applyReconciliation([target], true, repo, connector)).rejects.toThrow("response lost");
    expect((await repo.listStockReconciliations())[0]?.status).toBe("pending");
    connector.stockReconciliation = async () => accepted;
    await recoverStockReconciliations(repo, connector);
    expect(calls).toHaveLength(1);
    expect((await repo.listItems({ activeOnly: false }))[0]?.stockMilli).toBe(6000);
    expect((await repo.listOutbox("pending"))).toHaveLength(1);
    expect((await repo.listStockProtocolStates())[0]?.sequence).toBe(11);
    expect((await repo.listStockReconciliations())[0]?.status).toBe("done");
  });

  it("uses conditional stock operations for keep-local instead of invalidating hashes", async () => {
    const { repo, connector, target, calls } = await fixture();
    await applyReconciliation([target], false, repo, connector);
    expect(calls).toEqual([expect.objectContaining({ quantity: 5, expectedRevision: 3, generation: 1, variantId: "variant-uuid" })]);
    expect((await repo.listItems({ activeOnly: false }))[0]?.contentHash).toBe("hash");
  });

  it("records a terminal conflict without retiring local sources", async () => {
    const { repo, itemId, connector, target } = await fixture();
    await repo.adjustStock(itemId, -1000, "adjustment");
    connector.reconcileStock = async () => { throw new MarketplaceError("conflict", "stock changed", 409); };
    await expect(applyReconciliation([{ ...target, localValue: 4 }], true, repo, connector)).rejects.toThrow("stock changed");
    expect((await repo.listStockReconciliations())[0]?.status).toBe("conflict");
    expect(await repo.listOutbox("pending")).toHaveLength(1);
    await recoverStockReconciliations(repo, connector);
  });

  it("rejects stale local state before sending the remote operation", async () => {
    const { repo, itemId, connector, target, calls } = await fixture();
    await repo.adjustStock(itemId, -1000, "adjustment");
    await expect(applyReconciliation([target], true, repo, connector)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("fails closed on unsupported stock servers but keeps metadata usable", async () => {
    const { repo, target } = await fixture();
    const unsupported = {} as MarketplaceConnector;
    await expect(applyReconciliation([target], false, repo, unsupported)).rejects.toThrow("does not support");
    await expect(applyReconciliation([{ ...target, kind: "price", remoteValue: 120 }], true, repo, unsupported)).resolves.toBeUndefined();
    expect((await repo.listItems({ activeOnly: false }))[0]?.pricePaise).toBe(120);
  });

  it("does not pause an already-active epoch for a selected stock decision", async () => {
    const { repo, connector, target } = await fixture();
    await repo.setAppSetting("sync.stock_epoch", "epoch");
    await repo.setSyncCursor("stock", "8");
    await applyReconciliation([target], false, repo, connector);
    expect(await repo.getAppSetting("sync.stock_bootstrap_required")).toBeNull();
    expect(await repo.getSyncCursor("stock")).toBe("8");
  });

  it("rejects incomplete negotiated capabilities before upgrading or sending", async () => {
    const { repo, connector, target, calls } = await fixture();
    connector.stockProtocol = async () => ({ protocol: 2, capabilities: ["snapshot"] });
    await expect(applyReconciliation([target], false, repo, connector)).rejects.toThrow("does not support");
    expect(calls).toEqual([]);
    expect(await repo.listStockReconciliations()).toEqual([]);
  });

  it("bootstraps equal stock too, activates epoch, and skips completed items on resume", async () => {
    const { repo, itemId, connector, calls, remote } = await fixture();
    connector.stockSnapshot = async () => ({ protocol: 2, epoch: "epoch", watermark: 10, items: [{ ...remote, stockUnits: 5 }] });
    await bootstrapStock(repo, connector, false);
    expect(calls).toHaveLength(1);
    expect(await repo.getSyncCursor("stock")).toBe("0");
    expect(await repo.getAppSetting("sync.stock_bootstrap_required")).toBeNull();
    await repo.adjustStock(itemId, -1000, "adjustment");
    await bootstrapStock(repo, connector, false);
    expect(calls).toHaveLength(1);
    expect((await repo.listItems({ activeOnly: false }))[0]?.stockMilli).toBe(4000);
  });
});

describe("explicit shortage recovery", () => {
  const state = { externalId: "itm_1", variantId: "v", epoch: "e", sequence: 4, revision: 3, generation: 2, stockUnits: 2 };
  const parent = { ...state, operationId: "original", itemId: 1, choice: "remote" as const, expectedLocalStockMilli: 5000, capturedStockMilli: 5000, sourceBoundary: 1, status: "needs_review" as const, result: state, review: { currentStockMilli: 0, subsequentDeltaMilli: -3000, shortageMilli: 1000 } };
  function setup() {
    const journal = [parent] as import("@mytowncart-billing/storage").StockReconciliationIntent[];
    const repo = {
      listStockReconciliations: async () => journal,
      listItems: async () => [{ id: 1, stockMilli: 0 }],
      beginStockRecovery: vi.fn(async (input) => { const child = { ...input, capturedStockMilli: 0, sourceBoundary: 3, status: "pending" }; journal.push(child); return child; }),
      settleStockReconciliation: vi.fn(async (id, result) => { const child = journal.find((entry) => entry.operationId === id)!; Object.assign(child, { result, status: "needs_review", review: { currentStockMilli: 0, subsequentDeltaMilli: -1000, shortageMilli: 1000 } }); return child; }),
    } as unknown as BillingRepository;
    const accepted = new Map();
    const connector = {
      stockProtocol: async () => ({ protocol: 2, capabilities: ["committed_feed", "snapshot", "generation_fence", "conditional_reconcile", "operation_status"] }),
      enableStockProtocol: async () => ({}),
      stockSnapshot: vi.fn(async () => ({ epoch: "e", watermark: 5, items: [state] })),
      stockReconciliation: vi.fn(async (id) => accepted.get(id) ?? null),
      reconcileStock: vi.fn(async (request) => { const result = { ...state, operationId: request.operationId, stockUnits: 0, generation: 3, watermark: 6 }; accepted.set(request.operationId, result); return result; }),
    } as unknown as MarketplaceConnector;
    return { repo, connector, journal };
  }
  const decision = { parentOperationId: "original", expectedLocalStockMilli: 0, reason: "counted empty", confirmed: true };
  it("captures fresh revision and zero target without rewriting original; repeated shortage remains review", async () => {
    const { repo, connector, journal } = setup();
    const result = await recoverStockShortage(repo, connector, decision);
    expect(repo.beginStockRecovery).toHaveBeenCalledWith(expect.objectContaining({ parentOperationId: "original", choice: "remote", stockUnits: 0, expectedLocalStockMilli: 0, revision: 3 }));
    expect(result.status).toBe("needs_review");
    expect(journal[0]).toEqual(parent);
    await recoverStockShortage(repo, connector, decision);
    expect(repo.beginStockRecovery).toHaveBeenCalledTimes(1);
  });
  it("recovers lost child response after restart using durable status before any fresh snapshot", async () => {
    const { repo, connector } = setup();
    const send = connector.reconcileStock!;
    connector.reconcileStock = vi.fn(async (request) => { await send(request); throw new Error("lost response"); });
    await expect(recoverStockShortage(repo, connector, decision)).rejects.toThrow("lost response");
    await recoverStockShortage(repo, connector, decision);
    expect(connector.reconcileStock).toHaveBeenCalledTimes(1);
    expect(connector.stockSnapshot).toHaveBeenCalledTimes(1);
    expect(repo.beginStockRecovery).toHaveBeenCalledTimes(1);
  });
  it("resolves mapped evidence by a conditional captured local baseline, never source delivery", async () => {
    const { repo, connector } = setup();
    repo.listStockSourceResolutions = async () => [{ operationId: "mapping", sourceId: 7, idempotencyKey: "raw-key", rawPayloadJson: "bad", action: "map", itemId: 1, reason: "verified item", confirmed: true, actor: 1, createdAt: "2026-11-15T00:00:00Z" }];
    repo.getAppSetting = async () => null;
    repo.setAppSetting = vi.fn(async () => {});
    let enabled = false;
    connector.enableStockProtocol = vi.fn(async () => { enabled = true; return { protocol: 2 as const, epoch: "e", watermark: 5, items: [state] }; });
    connector.stockSnapshot = vi.fn(async () => { if (!enabled) throw new Error("legacy link not enabled"); return { protocol: 2 as const, epoch: "e", watermark: 5, items: [state] }; });
    repo.beginStockReconciliation = vi.fn(async (input) => ({ ...input, capturedStockMilli: 0, sourceBoundary: 7, status: "pending" }));
    repo.settleStockReconciliation = vi.fn(async () => ({ ...parent, status: "done" as const }));
    await reconcileMappedSource(repo, connector, { itemId: 1, expectedLocalStockMilli: 0, reason: "counted empty", confirmed: true });
    expect(repo.beginStockReconciliation).toHaveBeenCalledWith(expect.objectContaining({ itemId: 1, choice: "local", stockUnits: 0, expectedLocalStockMilli: 0 }));
    expect(connector.enableStockProtocol).toHaveBeenCalledWith(["itm_1"]);
    expect(repo.setAppSetting).toHaveBeenCalledWith("sync.stock_bootstrap_required", "true");
    repo.listStockSourceResolutions = async () => [];
    await expect(reconcileMappedSource(repo, connector, { itemId: 1, expectedLocalStockMilli: 0, reason: "counted empty", confirmed: true })).rejects.toThrow("already resolved");
  });
  it("rejects stale local consent and missing reason before child creation", async () => {
    const { repo, connector } = setup();
    await expect(recoverStockShortage(repo, connector, { ...decision, expectedLocalStockMilli: 1000 })).rejects.toThrow("Local stock changed");
    await expect(recoverStockShortage(repo, connector, { ...decision, reason: " " })).rejects.toThrow("reason");
    expect(repo.beginStockRecovery).not.toHaveBeenCalled();
  });
});

describe("reconciliation freshness", () => {
  const remote: RemoteItem = { externalId: "itm_1", productId: "p", variantId: "v", stockUnits: 7, pricePaise: 100, isActive: true };
  const snapshot = () => JSON.stringify({ version: 2, at: new Date().toISOString(), items: [
    { externalId: "itm_1", stockUnits: 7, pricePaise: 100, remoteHash: "100:7:1" },
  ] });
  const repo = (stockMilli = 5000, saved: string | null = snapshot()) => ({
    getAppSetting: async () => saved,
    listItems: async () => [{ id: 1, name: "Item", stockMilli, pricePaise: 100, remoteProductId: "p", isActive: true }],
  }) as unknown as BillingRepository;
  const connector = (items: RemoteItem[]) => ({ listRemoteItems: async () => items }) as unknown as MarketplaceConnector;
  const targets = [row("stock", 7)];

  it("accepts matching local and freshly read marketplace values", async () => {
    await expect(validateReconcileTargets(targets, repo(), connector([remote]))).resolves.toBeUndefined();
  });
  it("rejects changed marketplace values even in another field", async () => {
    await expect(validateReconcileTargets(targets, repo(), connector([{ ...remote, pricePaise: 101 }]))).rejects.toThrow("Sync now");
  });
  it("rejects local changes made by another client", async () => {
    await expect(validateReconcileTargets(targets, repo(6000), connector([remote]))).rejects.toThrow("Sync now");
  });
  it("rejects a new discrepancy in another field of a targeted item", async () => {
    const changed = { ...repo(), listItems: async () => [{ id: 1, name: "Item", stockMilli: 5000, pricePaise: 99, remoteProductId: "p", isActive: true }] } as BillingRepository;
    await expect(validateReconcileTargets(targets, changed, connector([remote]), targets)).rejects.toThrow("Sync now");
  });
  it("rejects missing, unavailable and ambiguous remote snapshots", async () => {
    await expect(validateReconcileTargets(targets, repo(), connector([]))).rejects.toThrow();
    await expect(validateReconcileTargets(targets, repo(5000, null), connector([remote]))).rejects.toThrow();
    await expect(validateReconcileTargets(targets, repo(), connector([remote, remote]))).rejects.toThrow();
  });
  it("does not treat a newly appearing item as missing", async () => {
    await expect(validateReconcileTargets([row("missing_remote", null)], repo(5000, JSON.stringify({ version: 2, at: new Date().toISOString(), items: [] })), connector([remote]))).rejects.toThrow();
  });
  it("fails closed when the marketplace cannot be read", async () => {
    const offline = { listRemoteItems: async () => { throw new Error("offline"); } } as unknown as MarketplaceConnector;
    await expect(validateReconcileTargets(targets, repo(), offline)).rejects.toThrow("offline");
  });
});
