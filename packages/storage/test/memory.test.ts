// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";

import { computeBill, financialYearFor } from "@mytowncart-billing/core";
import { MemoryRepository } from "../src/memory";
import type { ItemInput } from "../src/types";

let repo: MemoryRepository;

const itemInput = (over: Partial<ItemInput> = {}): ItemInput => ({
  name: "Parle-G",
  barcode: "",
  categoryId: null,
  unitKind: "count",
  pricePaise: 1000,
  mrpPaise: 1200,
  taxRateBp: 500,
  openingStockMilli: 0,
  isActive: true,
  ...over,
});

async function makeItem(over: Partial<ItemInput> = {}): Promise<number> {
  return repo.upsertItem(itemInput(over));
}

async function makeBill(
  itemId: number,
  qtyMilli: number,
  opts: { fy?: string; prefix?: string } = {},
): Promise<{ billId: number; number: string }> {
  const item = (await repo.getItem(itemId))!;
  const computed = computeBill(
    [
      {
        itemId,
        name: item.name,
        qtyMilli,
        unitPricePaise: item.pricePaise,
        taxRateBp: item.taxRateBp,
        unitKind: item.unitKind,
      },
    ],
    { pricesIncludeTax: false },
  );
  return repo.createBill({
    fy: opts.fy ?? "2026-27",
    prefix: opts.prefix ?? "INV-",
    customerId: null,
    subtotalPaise: computed.subtotalPaise,
    taxPaise: computed.taxPaise,
    totalPaise: computed.totalPaise,
    createdAt: "2026-11-04T10:00:00.000Z",
    lines: computed.lines.map((l) => ({
      itemId: l.itemId,
      nameSnapshot: l.name,
      qtyMilli: l.qtyMilli,
      unitPricePaise: l.unitPricePaise,
      taxRateBp: l.taxRateBp,
      taxPaise: l.taxPaise,
      totalPaise: l.totalPaise,
    })),
    payments: [{ mode: "cash", amountPaise: computed.totalPaise }],
  });
}

beforeEach(() => {
  repo = new MemoryRepository();
});

describe("stock pull cursor", () => {
  it("rejects a stale page without applying movements or changing the cursor", async () => {
    const id = await makeItem({ openingStockMilli: 2000 });
    const moves = [{ externalId: `itm_${id}`, deltaUnits: -1, reason: "online_order" as const, createdAt: "now" }];
    const results = await Promise.allSettled([
      repo.applyStockPull(null, "1", moves),
      repo.applyStockPull(null, "1", moves),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await repo.getItem(id))?.stockMilli).toBe(1000);
    expect(await repo.getSyncCursor("stock")).toBe("1");
    await expect(repo.applyStockPull("1", "1", moves)).rejects.toThrow("must advance");
    await repo.applyStockPull("1", "2", []);
    expect(await repo.getSyncCursor("stock")).toBe("2");
  });
});

describe("outbox acknowledgements", () => {
  it("rolls back a bad batch and never resurrects a done row", async () => {
    const id = await makeItem({ openingStockMilli: 2000 });
    await repo.recordPublish([{ itemId: id, state: "pending_store_approval", remoteProductId: "p1", remoteVariantId: "v1", contentHash: "abc" }], new Map());
    await repo.adjustStock(id, -1000, "adjustment");
    const [row] = await repo.listOutbox("pending");
    const done = { idempotencyKey: row!.idempotencyKey, outcome: "done" as const };
    await expect(repo.recordOutboxResults([done, { idempotencyKey: "missing", outcome: "done" }])).rejects.toThrow();
    expect(await repo.listOutbox("pending")).toEqual([row]);
    await repo.recordOutboxResults([done]);
    await repo.recordOutboxResults([{ idempotencyKey: row!.idempotencyKey, outcome: "retry", nextAttemptAt: "2030-01-01T00:00:00.000Z" }]);
    expect(await repo.listOutbox("pending")).toEqual([]);
    expect((await repo.listOutbox("done"))[0]).toMatchObject({ attempts: 1, nextAttemptAt: null });
  });
});

describe("reconcile pulls", () => {
  it("allows independent metadata while unrelated stock is pending and rejects legacy stock fixes", async () => {
    const id = await makeItem({ openingStockMilli: 2000 });
    const other = await makeItem({ openingStockMilli: 2000 });
    await repo.recordPublish([{ itemId: other, state: "pending_store_approval", remoteProductId: "p1", remoteVariantId: "v1", contentHash: "abc" }], new Map());
    await repo.adjustStock(other, -1000, "adjustment");
    const [pending] = await repo.listOutbox("pending");
    expect(pending).toBeDefined();
    const fixes = [
      { itemId: id, externalId: `itm_${id}`, pullToLocal: true, kind: "stock" as const, stockUnits: 5 },
      { itemId: id, externalId: `itm_${id}`, pullToLocal: false, kind: "price" as const },
    ];
    await expect(repo.applyReconcileFixes(fixes)).rejects.toThrow("durable protocol");
    await repo.applyReconcileFixes([{ itemId: id, externalId: `itm_${id}`, pullToLocal: true, kind: "price", pricePaise: 1700 }]);
    expect((await repo.getItem(id))?.pricePaise).toBe(1700);
    expect((await repo.getItem(id))?.stockMilli).toBe(2000);
    expect(await repo.listMovements(id)).toHaveLength(1);
    await repo.recordOutboxResults([{ idempotencyKey: pending!.idempotencyKey, outcome: "done" }]);
    await expect(repo.applyReconcileFixes(fixes)).rejects.toThrow("durable protocol");
  });

  it("applies observed values and records only real stock changes", async () => {
    const id = await makeItem({ openingStockMilli: 2000, isActive: false });
    const base = { itemId: id, externalId: `itm_${id}`, pullToLocal: true };
    await repo.applyReconcileFixes([
      { ...base, kind: "price", pricePaise: 0 },
      { ...base, kind: "remote_inactive", isActive: true },
    ]);
    const input = { operationId: "remote-choice", itemId: id, externalId: `itm_${id}`, choice: "remote" as const, expectedLocalStockMilli: 2000, stockUnits: 4, variantId: "variant-id", epoch: "epoch", sequence: 10, revision: 2, generation: 1 };
    await repo.beginStockReconciliation(input);
    await repo.settleStockReconciliation(input.operationId, { ...input, generation: 2, revision: 3 });
    await repo.settleStockReconciliation(input.operationId, { ...input, generation: 2, revision: 3 });
    expect(await repo.getItem(id)).toMatchObject({ pricePaise: 0, stockMilli: 4000, isActive: true });
    expect(await repo.listOutbox("pending")).toEqual([]);
    expect(await repo.listMovements(id)).toHaveLength(2);
  });

  it("rejects invalid pulls and leaves the whole batch untouched", async () => {
    const id = await makeItem({ openingStockMilli: 2000 });
    const base = { itemId: id, externalId: `itm_${id}`, pullToLocal: true };
    for (const bad of [
      { ...base, kind: "price" as const },
      { ...base, kind: "price" as const, pricePaise: -1 },
      { ...base, kind: "stock" as const, stockUnits: 1.5 },
      { ...base, kind: "stock" as const, stockUnits: Number.MAX_SAFE_INTEGER },
      { ...base, kind: "remote_inactive" as const },
      { ...base, kind: "stock" as const, stockUnits: 1, externalId: "wrong" },
    ]) {
      await expect(repo.applyReconcileFixes([{ ...base, kind: "stock", stockUnits: 5 }, bad])).rejects.toThrow();
      expect(await repo.getItem(id)).toMatchObject({ stockMilli: 2000, pricePaise: 1000, isActive: true });
      expect(await repo.listMovements(id)).toHaveLength(1);
    }
  });
});

describe("durable stock protocol parity", () => {
  const state = (externalId: string, stockUnits = 5) => ({ externalId, variantId: "variant-uuid", epoch: "epoch", sequence: 10, revision: 3, generation: 2, stockUnits });
  it("keeps immutable sale/void requests in order across expiry, retry and quarantine", async () => {
    const id = await makeItem({ openingStockMilli: 5000 });
    await repo.recordPublish([{ itemId: id, state: "live", remoteProductId: "remote", remoteVariantId: "variant-uuid", contentHash: "hash" }], new Map());
    await repo.adjustStock(id, -1000, "adjustment");
    await repo.adjustStock(id, 1000, "adjustment");
    const a = (await repo.claimStockDelivery("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z"))!;
    expect(await repo.claimStockDelivery("2026-01-01T00:00:01Z", "2026-01-01T00:01:01Z")).toBeNull();
    const b = (await repo.claimStockDelivery("2026-01-01T00:01:01Z", "2026-01-01T00:02:01Z"))!;
    expect(b.payloadJson).toBe(a.payloadJson);
    await expect(repo.settleStockDelivery(a.id, a.claimToken, "done")).rejects.toThrow("stale");
    await repo.settleStockDelivery(b.id, b.claimToken, "retry", "2026-01-01T00:05:00Z");
    expect(await repo.claimStockDelivery("2026-01-01T00:04:00Z", "2026-01-01T00:05:00Z")).toBeNull();
    const retry = (await repo.claimStockDelivery("2026-01-01T00:05:00Z", "2026-01-01T00:06:00Z"))!;
    expect(retry.payloadJson).toBe(a.payloadJson);
    await repo.settleStockDelivery(retry.id, retry.claimToken, "quarantined", undefined, "clamped");
    expect((await repo.listOutbox("quarantined"))[0]?.quarantineReason).toBe("clamped");
    expect(await repo.claimStockDelivery("2026-01-01T00:07:00Z", "2026-01-01T00:08:00Z")).toBeNull();
  });
  it("captures a durable boundary, rebases later sales and suppresses selected feed only", async () => {
    const id = await makeItem({ openingStockMilli: 5000 }); const other = await makeItem({ openingStockMilli: 5000 });
    await repo.recordPublish([{ itemId: id, state: "live", remoteProductId: "remote", remoteVariantId: "variant-uuid", contentHash: "hash" }], new Map());
    await repo.adjustStock(id, -1000, "adjustment");
    const request = { ...state(`itm_${id}`, 7), operationId: "decision", itemId: id, choice: "remote" as const, expectedLocalStockMilli: 4000 };
    const intent = await repo.beginStockReconciliation(request);
    await expect(repo.beginStockReconciliation({ ...request, stockUnits: 8 })).rejects.toThrow("changed payload");
    await repo.adjustStock(id, -1000, "adjustment");
    expect(await repo.claimStockDelivery("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z")).toBeNull();
    const result = { ...state(`itm_${id}`, 7), generation: 3, revision: 4, sequence: 12 };
    await repo.settleStockReconciliation(intent.operationId, result);
    await repo.settleStockReconciliation(intent.operationId, result);
    expect((await repo.getItem(id))?.stockMilli).toBe(6000);
    expect(await repo.listOutbox("pending")).toHaveLength(1);
    const applied = await repo.applyStockPull(null, "12", [
      { externalId: `itm_${id}`, deltaUnits: -2, reason: "online_order", createdAt: "now", epoch: "epoch", sequence: 11 },
      { externalId: `itm_${other}`, deltaUnits: -1, reason: "online_order", createdAt: "now", epoch: "epoch", sequence: 12 },
    ]);
    expect(applied.map((m) => m.itemId)).toEqual([other]);
    const delivery = (await repo.claimStockDelivery("2026-01-01T00:02:00Z", "2026-01-01T00:03:00Z"))!;
    expect(JSON.parse(delivery.payloadJson)).toMatchObject({ generation: 3, epoch: "epoch", variantId: "variant-uuid", deltaUnits: -1 });
  });
  it("rejects stale capture, unsafe fences and negative rebases without partial writes", async () => {
    const id = await makeItem({ openingStockMilli: 5000 });
    const request = { ...state(`itm_${id}`, 1), operationId: "decision", itemId: id, choice: "remote" as const, expectedLocalStockMilli: 4000 };
    await expect(repo.beginStockReconciliation(request)).rejects.toThrow("local stock changed");
    await repo.beginStockReconciliation({ ...request, expectedLocalStockMilli: 5000 });
    await expect(repo.beginStockReconciliation({ ...request, operationId: "conflict" })).rejects.toThrow("pending");
    await repo.adjustStock(id, -2000, "adjustment");
    expect((await repo.settleStockReconciliation("decision", { ...state(`itm_${id}`, 1), generation: 3, revision: 4 })).status).toBe("needs_review");
    expect((await repo.getItem(id))?.stockMilli).toBe(3000);
    expect(await repo.listStockProtocolStates()).toEqual([]);
    await expect(repo.rejectStockReconciliation("decision", "conflict")).rejects.toThrow("not pending");
    expect((await repo.listStockReconciliations())[0]?.status).toBe("needs_review");
  });
  it("activates only complete reconciled epochs and preserves same-epoch cursor", async () => {
    const id = await makeItem({ openingStockMilli: 5000 });
    await repo.recordPublish([{ itemId: id, state: "live", remoteProductId: "remote", remoteVariantId: "variant-uuid", contentHash: "hash" }], new Map());
    await expect(repo.activateStockEpoch("epoch")).rejects.toThrow("all linked");
    await expect(repo.saveStockProtocolStates([state("remote")])).rejects.toThrow("explicit reconciliation");
    await repo.beginStockReconciliation({ ...state("remote"), itemId: id, operationId: "bootstrap", choice: "local", expectedLocalStockMilli: 5000 });
    await repo.settleStockReconciliation("bootstrap", { ...state("remote"), generation: 3, revision: 4 });
    await repo.activateStockEpoch("epoch");
    expect(await repo.getAppSetting("sync.stock_epoch")).toBe("epoch");
    await repo.setSyncCursor("stock", "99"); await repo.activateStockEpoch("epoch");
    expect(await repo.getSyncCursor("stock")).toBe("99");
  });
});

describe("exceptional stock recovery", () => {
  const state = (id: number, stockUnits: number) => ({ externalId: `itm_${id}`, variantId: "variant", epoch: "epoch", sequence: 10, revision: 3, generation: 2, stockUnits });
  it("keeps committed evidence and repeats zero recovery with a fresh boundary and current shortage", async () => {
    const id = await makeItem({ openingStockMilli: 5000 });
    await repo.recordPublish([{ itemId: id, state: "live", remoteProductId: "marketplace-uuid", remoteVariantId: "variant", contentHash: "hash" }], new Map());
    await repo.beginStockReconciliation({ ...state(id, 1), operationId: "parent", itemId: id, choice: "remote", expectedLocalStockMilli: 5000 });
    await repo.adjustStock(id, -2000, "adjustment");
    const committed = { ...state(id, 1), generation: 3, revision: 4 };
    const parent = await repo.settleStockReconciliation("parent", committed);
    expect(parent.review?.shortageMilli).toBe(1000);
    await repo.adjustStock(id, -1000, "adjustment");
    const request = { ...committed, stockUnits: 0, operationId: "child", parentOperationId: "parent", itemId: id, choice: "remote" as const, expectedLocalStockMilli: 2000, reason: "Confirmed zero after later sale" };
    await expect(repo.beginStockRecovery({ ...request, expectedLocalStockMilli: 3000 })).rejects.toThrow("local stock changed");
    const child = await repo.beginStockRecovery(request); expect(child.approvedShortageMilli).toBe(2000);
    await expect(repo.beginStockRecovery({ ...request, reason: "changed" })).rejects.toThrow("changed payload");
    await repo.adjustStock(id, -1000, "adjustment");
    const childResult = { ...committed, stockUnits: 0, generation: 4, revision: 5 };
    expect((await repo.settleStockReconciliation("child", childResult)).status).toBe("needs_review");
    await expect(repo.settleStockReconciliation("parent", { ...committed, sequence: 11 })).rejects.toThrow("result changed");
    await expect(repo.activateStockEpoch("epoch")).rejects.toThrow("pending");
    expect(await repo.claimStockDelivery("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z")).toBeNull();
    await repo.beginStockRecovery({ ...request, ...childResult, operationId: "grandchild", parentOperationId: "child", expectedLocalStockMilli: 1000 });
    const result = { ...childResult, generation: 5, revision: 6 };
    await repo.settleStockReconciliation("grandchild", result); await repo.settleStockReconciliation("grandchild", result);
    expect((await repo.getItem(id))?.stockMilli).toBe(0);
    expect((await repo.listStockReconciliations()).map((i) => i.status)).toEqual(["done", "done", "done"]);
    expect((await repo.listStockReconciliations())[0]?.result).toEqual(committed);
    expect(await repo.listOutbox("pending")).toHaveLength(0);
  });
  it("maps only unusable quarantined evidence, fences feed and retires only captured associations", async () => {
    const id = await makeItem({ openingStockMilli: 5000 });
    await repo.recordPublish([{ itemId: id, state: "live", remoteProductId: "marketplace-uuid", remoteVariantId: "variant", contentHash: "hash" }], new Map());
    const rows: import("../src/types").OutboxRow[] = [1, 2, 3].map((n) => ({ id: n, externalId: "", idempotencyKey: `legacy-${n}`, deltaUnits: 0, reason: "sale", attempts: 0, nextAttemptAt: null, status: "quarantined", rawPayloadJson: "not-json" }));
    (repo as unknown as { outbox: typeof rows }).outbox = rows;
    const mapping = { operationId: "map", sourceId: 1, idempotencyKey: "legacy-1", rawPayloadJson: "not-json", action: "map" as const, itemId: id, reason: "Verified source ownership", confirmed: true };
    const evidence = await repo.resolveStockSource(mapping); expect(evidence.externalId).toBe(`itm_${id}`); expect(evidence.createdAt).toBeTruthy();
    await expect(repo.resolveStockSource({ ...mapping, reason: "changed" })).rejects.toThrow("changed payload");
    await expect(repo.resolveStockSource({ ...mapping, operationId: "duplicate" })).rejects.toThrow("already");
    await expect(repo.applyStockPull(null, "11", [{ externalId: `itm_${id}`, deltaUnits: -1, reason: "online_order", createdAt: "now", epoch: "epoch", sequence: 11 }])).rejects.toThrow("pending");
    await repo.beginStockReconciliation({ ...state(id, 5), operationId: "settle-map", itemId: id, choice: "local", expectedLocalStockMilli: 5000 });
    await repo.resolveStockSource({ ...mapping, operationId: "late-map", sourceId: 2, idempotencyKey: "legacy-2" });
    await repo.resolveStockSource({ ...mapping, operationId: "unknown", sourceId: 3, idempotencyKey: "legacy-3", action: "historical_unknown", itemId: undefined });
    await repo.settleStockReconciliation("settle-map", { ...state(id, 5), revision: 4, generation: 3 });
    const history = await repo.listStockSourceResolutions(); expect(history[0]?.retiredBy).toBe("settle-map"); expect(history[1]?.retiredBy).toBeUndefined(); expect(history[2]?.retiredBy).toBeUndefined();
    expect((await repo.listOutbox("quarantined")).map((r) => r.id)).toEqual([2, 3]);
    expect((await repo.getItem(id))?.stockMilli).toBe(5000);
  });
  it("rejects settlement of conflicted intents", async () => {
    const id = await makeItem({ openingStockMilli: 5000 });
    await repo.beginStockReconciliation({ ...state(id, 5), operationId: "conflict", itemId: id, choice: "local", expectedLocalStockMilli: 5000 });
    await repo.rejectStockReconciliation("conflict", "stale revision");
    await expect(repo.settleStockReconciliation("conflict", { ...state(id, 5), generation: 3, revision: 4 })).rejects.toThrow("not pending");
    expect((await repo.getItem(id))?.stockMilli).toBe(5000);
  });
});

describe("shop profile", () => {
  it("starts empty (drives the first-run setup wizard)", async () => {
    expect(await repo.getShopProfile()).toBeNull();
    await repo.saveShopProfile({
      name: "Guna Stores",
      gstEnabled: true,
      pricesIncludeTax: true,
      invoicePrefix: "GS-",
      address: "",
      phone: "",
      gstin: "",
      receiptFooter: "",
      lowStockThresholdMilli: 5000,
    });
    expect((await repo.getShopProfile())!.invoicePrefix).toBe("GS-");
  });
});

describe("items", () => {
  it("creates with opening stock as a ledger movement + cached sum", async () => {
    const id = await makeItem({ openingStockMilli: 10_000 });
    const item = (await repo.getItem(id))!;
    expect(item.stockMilli).toBe(10_000);
    const moves = await repo.listMovements(id);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ deltaMilli: 10_000, reason: "opening" });
  });

  it("updates without touching stock", async () => {
    const id = await makeItem({ openingStockMilli: 5_000 });
    await repo.upsertItem(itemInput({ id, name: "Renamed", openingStockMilli: 99_000 }));
    const item = (await repo.getItem(id))!;
    expect(item.name).toBe("Renamed");
    expect(item.stockMilli).toBe(5_000);
  });

  it("finds by barcode and searches by name", async () => {
    const id = await makeItem({ barcode: "8901234" });
    expect((await repo.findItemByBarcode("8901234"))!.id).toBe(id);
    expect(await repo.findItemByBarcode("nope")).toBeNull();
    await makeItem({ name: "Rice 5kg" });
    const hits = await repo.listItems({ search: "rice" });
    expect(hits.map((i) => i.name)).toEqual(["Rice 5kg"]);
  });

  it("stores, updates, and searches by brand, description, and custom attributes", async () => {
    const id = await makeItem({
      name: "Organic Honey",
      brand: "NaturePure",
      description: "100% pure raw mountain honey",
      customAttributes: { Origin: "Himalayas", Grade: "A+" },
    });
    const item = (await repo.getItem(id))!;
    expect(item.brand).toBe("NaturePure");
    expect(item.description).toBe("100% pure raw mountain honey");
    expect(item.customAttributes).toEqual({ Origin: "Himalayas", Grade: "A+" });

    // Update
    await repo.upsertItem({
      id,
      name: "Organic Honey 500g",
      barcode: "",
      categoryId: null,
      unitKind: "count",
      pricePaise: 35000,
      mrpPaise: 35000,
      taxRateBp: 500,
      openingStockMilli: 0,
      isActive: true,
      brand: "NaturePure Gold",
      description: "Updated honey description",
      customAttributes: { Origin: "Himalayas", Grade: "Premium", Weight: "500g" },
    });
    const updated = (await repo.getItem(id))!;
    expect(updated.brand).toBe("NaturePure Gold");
    expect(updated.description).toBe("Updated honey description");
    expect(updated.customAttributes).toEqual({ Origin: "Himalayas", Grade: "Premium", Weight: "500g" });

    // Search by brand
    const brandHits = await repo.listItems({ search: "naturepure" });
    expect(brandHits.map((i) => i.id)).toContain(id);

    // Search by description
    const descHits = await repo.listItems({ search: "updated honey" });
    expect(descHits.map((i) => i.id)).toContain(id);

    // Search by custom attribute
    const attrHits = await repo.listItems({ search: "himalayas" });
    expect(attrHits.map((i) => i.id)).toContain(id);
  });

  it("import isolates bad rows and re-importing a barcode updates", async () => {
    const results = await repo.importItems([
      itemInput({ barcode: "111", openingStockMilli: 1000 }),
      itemInput({ name: "" }),
      itemInput({ barcode: "111", name: "Updated" }),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    const all = await repo.listItems();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("Updated");
  });
});

describe("bills", () => {
  it("allocates gap-free sequential numbers per FY", async () => {
    const itemId = await makeItem({ openingStockMilli: 1_000_000 });
    const numbers: string[] = [];
    for (let i = 0; i < 10; i += 1) numbers.push((await makeBill(itemId, 1000)).number);
    expect(numbers).toEqual([
      "INV-0001", "INV-0002", "INV-0003", "INV-0004", "INV-0005",
      "INV-0006", "INV-0007", "INV-0008", "INV-0009", "INV-0010",
    ]);
  });

  it("restarts the sequence across the FY boundary", async () => {
    const itemId = await makeItem({ openingStockMilli: 1_000_000 });
    expect((await makeBill(itemId, 1000, { fy: financialYearFor("2026-03-31") })).number).toBe("INV-0001");
    expect((await makeBill(itemId, 1000, { fy: financialYearFor("2026-04-01") })).number).toBe("INV-0001");
    expect((await makeBill(itemId, 1000, { fy: financialYearFor("2026-04-01") })).number).toBe("INV-0002");
  });

  it("sale decrements stock; void restores it via compensating movements", async () => {
    const itemId = await makeItem({ openingStockMilli: 10_000 });
    const { billId } = await makeBill(itemId, 2500);
    expect((await repo.getItem(itemId))!.stockMilli).toBe(7_500);

    await repo.voidBill(billId, "test void");
    expect((await repo.getItem(itemId))!.stockMilli).toBe(10_000);

    const moves = await repo.listMovements(itemId);
    const sum = moves.reduce((s, m) => s + m.deltaMilli, 0);
    expect(sum).toBe(10_000);
    expect(moves.map((m) => m.reason).sort()).toEqual(["opening", "sale", "void"]);

    const bill = (await repo.getBill(billId))!;
    expect(bill.status).toBe("void");
    expect(bill.voidReason).toBe("test void");
    await expect(repo.voidBill(billId, "again")).rejects.toThrow("already void");
    await expect(repo.voidBill(billId, " ")).rejects.toThrow("reason");
  });

  it("lists and fetches bills with lines and payments", async () => {
    const itemId = await makeItem({ openingStockMilli: 10_000 });
    const { billId } = await makeBill(itemId, 1000);
    const list = await repo.listBills();
    expect(list).toHaveLength(1);
    const detail = (await repo.getBill(billId))!;
    expect(detail.lines[0]).toMatchObject({ nameSnapshot: "Parle-G", qtyMilli: 1000, taxPaise: 50 });
    expect(detail.payments[0]).toMatchObject({ mode: "cash", amountPaise: 1050 });
    // search by number
    expect(await repo.listBills({ search: "inv-0001" })).toHaveLength(1);
    expect(await repo.listBills({ search: "zzz" })).toHaveLength(0);
  });
});

describe("stock", () => {
  it("adjustStock records a movement and updates the cache", async () => {
    const itemId = await makeItem({ openingStockMilli: 5000 });
    await repo.adjustStock(itemId, -500, "adjustment");
    await repo.adjustStock(itemId, 10_000, "purchase");
    expect((await repo.getItem(itemId))!.stockMilli).toBe(14_500);
    await expect(repo.adjustStock(itemId, 0, "adjustment")).rejects.toThrow();
    await expect(repo.adjustStock(999, 1, "adjustment")).rejects.toThrow("no item");
  });
});

describe("customers and categories", () => {
  it("upserts and searches customers", async () => {
    const id = await repo.upsertCustomer({ name: "Ravi", phone: "9999999999" });
    await repo.upsertCustomer({ id, name: "Ravi Kumar", phone: "9999999999" });
    const all = await repo.listCustomers();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("Ravi Kumar");
    expect(await repo.listCustomers("9999")).toHaveLength(1);
  });

  it("dedupes categories by name", async () => {
    const a = await repo.upsertCategory({ name: "Snacks" });
    const b = await repo.upsertCategory({ name: "Snacks" });
    expect(a).toBe(b);
    const id = await makeItem({ categoryId: a });
    expect((await repo.getItem(id))!.categoryName).toBe("Snacks");
  });
});

describe("publish persistence (B2)", () => {
  const UUID = "11111111-2222-3333-4444-555555555555";

  it("stores category mappings and item publish outcomes", async () => {
    const catId = await repo.upsertCategory({ name: "Snacks" });
    const itemId = await makeItem({ categoryId: catId });

    await repo.recordPublish(
      [
        {
          itemId,
          state: "pending_store_approval",
          remoteProductId: "p1",
          remoteVariantId: "v1",
          contentHash: "abc12345",
        },
      ],
      new Map([[catId, UUID]]),
    );

    expect(await repo.listCategories()).toEqual([
      { id: catId, name: "Snacks", marketplaceCategoryId: UUID },
    ]);
    const item = await repo.getItem(itemId);
    expect(item).toMatchObject({
      publishState: "pending_store_approval",
      remoteProductId: "p1",
      remoteVariantId: "v1",
      contentHash: "abc12345",
    });
  });

  it("leaves items untouched when no outcome mentions them", async () => {
    const itemId = await makeItem();
    await repo.recordPublish([], new Map());
    expect((await repo.getItem(itemId))?.publishState).toBe("local_only");
  });

  it("rejects a mapping for an unknown category", async () => {
    await expect(repo.setCategoryMarketplaceId(99, UUID)).rejects.toThrow(/no category/);
  });
});

describe("photos and held bills", () => {
  beforeEach(() => {
    repo = new MemoryRepository();
  });

  it("stores, hashes and clears a photo", async () => {
    const id = await makeItem();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await repo.setItemPhoto(id, bytes, "hash-a");
    expect((await repo.getItem(id))?.photoFile).not.toBe("");
    expect(await repo.readItemPhoto(id)).toEqual({ bytes, imageHash: "hash-a" });

    await repo.clearItemPhoto(id);
    expect((await repo.getItem(id))?.photoFile).toBe("");
    expect(await repo.readItemPhoto(id)).toBeNull();
  });

  it("ignores an upload ack for a photo that was replaced meanwhile", async () => {
    const id = await makeItem();
    await repo.setItemPhoto(id, new Uint8Array([1]), "new-hash");
    await repo.recordImageUploads([
      { itemId: id, imageHash: "old-hash", uploadedAt: "2026-11-05T10:00:00.000Z" },
    ]);
    expect((await repo.getItem(id))?.imageUploadedAt).toBeNull();

    await repo.recordImageUploads([
      { itemId: id, imageHash: "new-hash", uploadedAt: "2026-11-05T10:01:00.000Z" },
    ]);
    expect((await repo.getItem(id))?.imageUploadedAt).toBe("2026-11-05T10:01:00.000Z");
  });

  it("handles multi-image lifecycle, ordering, and main promotion", async () => {
    const id = await makeItem();
    const bytes1 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);
    const bytes2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2]);

    const img1 = await repo.addItemImage(id, bytes1, "hash-1");
    expect(img1.isMain).toBe(true);
    expect(img1.imageHash).toBe("hash-1");

    const img2 = await repo.addItemImage(id, bytes2, "hash-2");
    expect(img2.isMain).toBe(false);

    let list = await repo.listItemImages(id);
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe(img1.id);
    expect(list[0]!.isMain).toBe(true);

    // Promote img2 to main
    await repo.setItemImageMain(img2.id);
    list = await repo.listItemImages(id);
    expect(list[0]!.id).toBe(img2.id);
    expect(list[0]!.isMain).toBe(true);
    expect(list[1]!.isMain).toBe(false);

    // Record upload for img2
    await repo.recordImageUploads([
      { itemId: id, imageHash: "hash-2", uploadedAt: "2026-11-10T12:00:00.000Z" },
    ]);
    list = await repo.listItemImages(id);
    expect(list[0]!.imageUploadedAt).toBe("2026-11-10T12:00:00.000Z");

    // Read image
    const read = await repo.readItemImage(img2.id);
    expect(read).toEqual({ bytes: bytes2, imageHash: "hash-2" });

    // Delete img2 (which is main) -> img1 promoted to main
    await repo.deleteItemImage(img2.id);
    list = await repo.listItemImages(id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(img1.id);
    expect(list[0]!.isMain).toBe(true);
  });

  it("round-trips a held bill", async () => {
    const id = await makeItem();
    const heldId = await repo.saveHeldBill({
      label: "Ramesh",
      customerId: null,
      lines: [{ itemId: id, qtyMilli: 2000 }],
    });
    const held = await repo.listHeldBills();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id: heldId, label: "Ramesh", lines: [{ itemId: id, qtyMilli: 2000 }] });

    await repo.takeHeldBill(heldId);
    expect(await repo.listHeldBills()).toEqual([]);
  });
});

describe("customer credit ledger and report batching", () => {
  beforeEach(() => {
    repo = new MemoryRepository();
  });

  it("records customer payments, builds ledger summary, and restricts deletion", async () => {
    const custId = await repo.upsertCustomer({
      name: "Suresh",
      phone: "9876543210",
      gstin: "33AAAAA0000A1Z5",
      address: "123 Market St",
    });

    const itemId = await makeItem({ pricePaise: 5000 });

    // Create a credit sale bill
    await repo.createBill({
      fy: "2026-27",
      prefix: "INV-",
      customerId: custId,
      subtotalPaise: 5000,
      taxPaise: 0,
      totalPaise: 5000,
      createdAt: "2026-11-06T10:00:00Z",
      lines: [
        {
          itemId,
          nameSnapshot: "Item 1",
          qtyMilli: 1000,
          unitPricePaise: 5000,
          taxRateBp: 0,
          taxPaise: 0,
          totalPaise: 5000,
          discountPaise: 0,
          hsnCode: "1905",
        },
      ],
      payments: [{ mode: "credit", amountPaise: 5000 }],
    });

    // Cannot delete customer who has bills
    await expect(repo.deleteCustomer(custId)).rejects.toThrow(/cannot delete/);

    // Initial ledger check
    let ledger = await repo.getCustomerLedger(custId);
    expect(ledger.totalCreditBilledPaise).toBe(5000);
    expect(ledger.totalPaidPaise).toBe(0);
    expect(ledger.outstandingBalancePaise).toBe(5000);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]!.balancePaise).toBe(5000);

    // Record partial payment
    await repo.recordCustomerPayment({
      customerId: custId,
      amountPaise: 2000,
      mode: "upi",
      notes: "Google Pay payment",
      createdAt: "2026-11-06T11:00:00Z",
    });

    ledger = await repo.getCustomerLedger(custId);
    expect(ledger.totalCreditBilledPaise).toBe(5000);
    expect(ledger.totalPaidPaise).toBe(2000);
    expect(ledger.outstandingBalancePaise).toBe(3000);
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries[1]!.balancePaise).toBe(3000);
  });

  it("fetches batch report data without N+1 IPC calls", async () => {
    const itemId = await makeItem({ pricePaise: 1000 });
    await repo.createBill({
      fy: "2026-27",
      prefix: "INV-",
      customerId: null,
      subtotalPaise: 1000,
      taxPaise: 0,
      totalPaise: 1000,
      createdAt: "2026-11-06T10:00:00Z",
      lines: [
        {
          itemId,
          nameSnapshot: "Item",
          qtyMilli: 1000,
          unitPricePaise: 1000,
          taxRateBp: 0,
          taxPaise: 0,
          totalPaise: 1000,
        },
      ],
      payments: [{ mode: "cash", amountPaise: 1000 }],
    });

    const reportData = await repo.getBillsReportData({
      from: "2026-11-01T00:00:00Z",
      to: "2026-11-10T23:59:59Z",
    });
    expect(reportData).toHaveLength(1);
    expect(reportData[0]!.lines).toHaveLength(1);
    expect(reportData[0]!.payments).toHaveLength(1);
    expect(reportData[0]!.payments[0]!.amountPaise).toBe(1000);
  });
});

describe("stock outbox parity", () => {
  it("enqueues linked sales, returns and purchases as separate movements", async () => {
    const itemId = await makeItem({ openingStockMilli: 10_000 });
    await repo.recordPublish([{ itemId, state: "pending_store_approval", remoteProductId: "p1", remoteVariantId: null, contentHash: "hash" }], new Map());
    const bill = await makeBill(itemId, 1000);
    await repo.createCreditNote({
      billId: bill.billId, reason: "Return", createdAt: "2026-11-06T12:00:00Z",
      lines: [{ itemId, nameSnapshot: "Parle-G", qtyMilli: 1000, unitPricePaise: 1000, taxRateBp: 500, taxPaise: 50, totalPaise: 1050, hsnCode: "1905" }],
    });
    const supplierId = await repo.upsertSupplier({ name: "Supplier", phone: "", gstin: "", address: "" });
    await repo.createPurchase({
      supplierId, invoiceNo: "PO-1", invoiceDate: "2026-11-06", createdAt: "2026-11-06T12:00:00Z",
      lines: [{ itemId, nameSnapshot: "Parle-G", qtyMilli: 2000, unitCostPaise: 500, taxRateBp: 0 }],
    });
    const rows = await repo.listOutbox("pending");
    expect(rows.map((row) => [row.externalId, row.deltaUnits, row.reason])).toEqual([
      [`itm_${itemId}`, -1, "sale"], [`itm_${itemId}`, 1, "adjustment"], [`itm_${itemId}`, 2, "adjustment"],
    ]);
    expect(rows[0]!.idempotencyKey).toMatch(/^bill:/);
    expect(rows[1]!.idempotencyKey).toMatch(/^bill:/);
    expect(rows[2]!.idempotencyKey).toMatch(/^adj:/);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(3);
  });
});

describe("credit notes", () => {
  it("creates credit note, generates sequential number and restores stock", async () => {
    const itemId = await makeItem({ openingStockMilli: 10_000, pricePaise: 1000 });
    const bill = await makeBill(itemId, 3000);
    expect((await repo.getItem(itemId))!.stockMilli).toBe(7000);

    const cn = await repo.createCreditNote({
      billId: bill.billId,
      reason: "Damaged packaging",
      createdAt: "2026-11-06T12:00:00Z",
      lines: [
        {
          itemId,
          nameSnapshot: "Parle-G",
          qtyMilli: 1000,
          unitPricePaise: 1000,
          taxRateBp: 500,
          taxPaise: 50,
          totalPaise: 1050,
          hsnCode: "1905",
        },
      ],
    });

    expect(cn.number).toBe("CN-2026-27-0001");
    // Stock restored from 7000 to 8000
    expect((await repo.getItem(itemId))!.stockMilli).toBe(8000);

    const notes = await repo.listCreditNotes(bill.billId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.number).toBe("CN-2026-27-0001");
    expect(notes[0]!.lines).toHaveLength(1);
    expect(notes[0]!.lines[0]!.hsnCode).toBe("1905");

    const single = await repo.getCreditNote(cn.creditNoteId);
    expect(single).not.toBeNull();
    expect(single!.reason).toBe("Damaged packaging");
  });
});

describe("suppliers and purchases", () => {
  it("creates supplier, records purchase, increments stock and updates cost price", async () => {
    const sId = await repo.upsertSupplier({
      name: "Metro Wholesalers",
      phone: "9876500000",
      gstin: "33AAACM1234F1Z5",
      address: "Chennai",
    });
    expect(sId).toBeGreaterThan(0);

    const itemId = await makeItem({ openingStockMilli: 2000, costPricePaise: 500 });

    const p = await repo.createPurchase({
      supplierId: sId,
      invoiceNo: "PO-100",
      invoiceDate: "2026-11-06",
      createdAt: "2026-11-06T12:00:00Z",
      lines: [
        {
          itemId,
          nameSnapshot: "Parle-G",
          qtyMilli: 5000,
          unitCostPaise: 750,
          taxRateBp: 500,
        },
      ],
    });
    expect(p.purchaseId).toBeGreaterThan(0);

    // Stock incremented from 2000 to 7000
    const item = (await repo.getItem(itemId))!;
    expect(item.stockMilli).toBe(7000);
    expect(item.costPricePaise).toBe(750);

    const purchases = await repo.listPurchases(sId);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]!.supplierName).toBe("Metro Wholesalers");
    expect(purchases[0]!.lines).toHaveLength(1);

    // Deleting supplier with purchases fails
    await expect(repo.deleteSupplier(sId)).rejects.toThrow("cannot delete supplier with recorded purchases");
  });
});

describe("users, pin and audit logs", () => {
  it("manages users, verifies pin and logs audit actions", async () => {
    const u1 = await repo.upsertUser({
      name: "Owner",
      role: "owner",
      pin: "1234",
    });
    const u2 = await repo.upsertUser({
      name: "Cashier",
      role: "cashier",
      pin: "9999",
    });

    const users = await repo.listUsers();
    expect(users).toHaveLength(2);

    expect(await repo.verifyPin("1234", "owner")).toMatchObject({ id: u1, role: "owner" });
    expect(await repo.verifyPin("9999", "owner")).toBeNull();
    expect(await repo.verifyPin("9999", "cashier")).toMatchObject({ id: u2, role: "cashier" });
    expect(await repo.verifyPin("wrong")).toBeNull();

    const logId = await repo.recordAuditLog({
      userId: u1,
      action: "bill_void",
      details: "Voided INV-2026-0001",
    });
    expect(logId).toBeGreaterThan(0);

    const logs = await repo.listAuditLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.userName).toBe("Owner");
    expect(logs[0]!.action).toBe("bill_void");
  });
});

describe("stock audit", () => {
  it("adjusts stock discrepancy correctly", async () => {
    const a = await makeItem({ openingStockMilli: 10_000 });
    const b = await makeItem({ openingStockMilli: 5_000 });

    const adjusted = await repo.applyStockAudit([
      { itemId: a, physicalCountMilli: 9_000 },
      { itemId: b, physicalCountMilli: 5_000 },
    ]);

    expect(adjusted).toBe(1);
    expect((await repo.getItem(a))!.stockMilli).toBe(9_000);
    expect((await repo.getItem(b))!.stockMilli).toBe(5_000);
  });
});

describe("batches and expiry tracking", () => {
  it("tracks batches with FIFO sorting and expiry alerts", async () => {
    const itemId = await makeItem();

    const _b1 = await repo.upsertBatch({
      itemId,
      batchNo: "BATCH-MAY",
      mfgDate: "2026-01-01",
      expiryDate: "2026-05-15",
      costPricePaise: 1000,
      mrpPaise: 1500,
      stockMilli: 2000,
    });
    const _b2 = await repo.upsertBatch({
      itemId,
      batchNo: "BATCH-FEB",
      mfgDate: "2025-11-01",
      expiryDate: "2026-02-10",
      costPricePaise: 900,
      mrpPaise: 1500,
      stockMilli: 5000,
    });

    const batches = await repo.listBatchesForItem(itemId);
    expect(batches).toHaveLength(2);
    // FIFO sorting: BATCH-FEB (2026-02-10) comes first
    expect(batches[0]!.batchNo).toBe("BATCH-FEB");
    expect(batches[1]!.batchNo).toBe("BATCH-MAY");

    const expiring = await repo.listExpiringBatches(180);
    expect(expiring.length).toBeGreaterThanOrEqual(1);
  });
});

describe("customer loyalty points", () => {
  it("accrues and redeems points with ledger logging", async () => {
    const custId = await repo.upsertCustomer({
      name: "Loyal Shopper",
      phone: "9876543210",
    });

    const bal1 = await repo.updateCustomerLoyalty(custId, 50, 101, "Bill points earned");
    expect(bal1).toBe(50);
    expect(await repo.getCustomerLoyaltyBalance(custId)).toBe(50);

    const bal2 = await repo.updateCustomerLoyalty(custId, -20, 102, "Redeemed points");
    expect(bal2).toBe(30);
    expect(await repo.getCustomerLoyaltyBalance(custId)).toBe(30);

    const txs = await repo.listLoyaltyTransactions(custId);
    expect(txs).toHaveLength(2);
    expect(txs[0]!.pointsDelta).toBe(-20);
    expect(txs[1]!.pointsDelta).toBe(50);
  });
});

describe("voiding a bill reverses its loyalty points", () => {
  it("gives back redeemed points and removes earned ones", async () => {
    const itemId = await makeItem({ pricePaise: 10_000, taxRateBp: 0 });
    const customerId = await repo.upsertCustomer({ name: "Loyal", phone: "9000000001" });
    await repo.updateCustomerLoyalty(customerId, 20, null, "seed");
    const sale = await repo.createBill({
      fy: "2026-27",
      prefix: "INV-",
      customerId,
      subtotalPaise: 10_000,
      taxPaise: 0,
      totalPaise: 10_000,
      createdAt: "2026-11-04T10:00:00.000Z",
      lines: [
        { itemId, nameSnapshot: "x", qtyMilli: 1000, unitPricePaise: 10_000, taxRateBp: 0, taxPaise: 0, totalPaise: 10_000 },
      ],
      payments: [{ mode: "cash", amountPaise: 10_000 }],
      loyaltyEarned: 5,
      loyaltyRedeemed: 8,
    });
    expect(await repo.getCustomerLoyaltyBalance(customerId)).toBe(17);
    await repo.voidBill(sale.billId, "wrong bill");
    expect(await repo.getCustomerLoyaltyBalance(customerId)).toBe(20);
  });
});

describe("multi-barcodes per item", () => {
  it("supports multiple secondary barcodes and barcode lookup", async () => {
    const itemId = await makeItem({ barcode: "8901234567890" });

    const bId = await repo.upsertItemBarcode(itemId, "8901234567891", 6000, "6-Pack Case");
    expect(bId).toBeGreaterThan(0);

    const barcodes = await repo.listItemBarcodes(itemId);
    expect(barcodes).toHaveLength(1);
    expect(barcodes[0]!.label).toBe("6-Pack Case");

    // Lookup primary
    const res1 = await repo.lookupItemByAnyBarcode("8901234567890");
    expect(res1).not.toBeNull();
    expect(res1!.itemId).toBe(itemId);
    expect(res1!.packQtyMilli).toBe(1000);

    // Lookup secondary
    const res2 = await repo.lookupItemByAnyBarcode("8901234567891");
    expect(res2).not.toBeNull();
    expect(res2!.itemId).toBe(itemId);
    expect(res2!.packQtyMilli).toBe(6000);

    // Delete barcode
    await repo.deleteItemBarcode(bId);
    expect(await repo.listItemBarcodes(itemId)).toHaveLength(0);
    expect(await repo.lookupItemByAnyBarcode("8901234567891")).toBeNull();
  });
});

describe("day-end closure and expected cash", () => {
  it("computes expected cash from day's transactions and saves closure", async () => {
    const itemId = await makeItem({ pricePaise: 5000 });
    const today = "2026-11-06";

    // Create cash bill
    await repo.createBill({
      fy: "26-27",
      prefix: "INV",
      customerId: null,
      subtotalPaise: 5000,
      taxPaise: 250,
      totalPaise: 5250,
      createdAt: `${today}T10:00:00Z`,
      lines: [
        {
          itemId,
          nameSnapshot: "Test Item",
          qtyMilli: 1000,
          unitPricePaise: 5000,
          taxRateBp: 500,
          taxPaise: 250,
          totalPaise: 5250,
        },
      ],
      payments: [{ mode: "cash", amountPaise: 5250 }],
    });

    const expected = await repo.getDayEndExpectedCash(today);
    expect(expected.cashSalesPaise).toBe(5250);
    expect(expected.totalBillsCount).toBe(1);
    expect(expected.totalSalesPaise).toBe(5250);

    const closureId = await repo.createDayEndClosure({
      closureDate: today,
      openingCashPaise: 200000,
      cashSalesPaise: expected.cashSalesPaise,
      creditReceivedPaise: 0,
      cashRefundsPaise: 0,
      expectedCashPaise: 205250,
      actualCashPaise: 205250,
      variancePaise: 0,
      totalBillsCount: expected.totalBillsCount,
      totalSalesPaise: expected.totalSalesPaise,
      notes: "Balanced drawer",
    });
    expect(closureId).toBeGreaterThan(0);

    const closures = await repo.listDayEndClosures();
    expect(closures).toHaveLength(1);
    expect(closures[0]!.variancePaise).toBe(0);
  });
});
