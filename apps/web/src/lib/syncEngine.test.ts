// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { MarketplaceError } from "@mytowncart-billing/connector-mytowncart";
import type {
  MarketplaceConnector,
  RemoteItem,
  StockPush,
  StockPushResult,
  UpsertResult,
  PublishItem,
} from "@mytowncart-billing/connector-mytowncart";
import { MemoryRepository } from "@mytowncart-billing/storage";

import { getReconcileSnapshot, listReconcileRows, runSync } from "./syncEngine";
import { invalidateRemoteSeen, loadRemoteSeen, saveRemoteSeen } from "./remoteSeen";

type ConnectorOverrides = Partial<MarketplaceConnector> & { pushes?: StockPush[][] };

function fakeConnector(overrides: ConnectorOverrides = {}): MarketplaceConnector {
  const { pushes, ...rest } = overrides;
  const ok = (items: PublishItem[]): UpsertResult[] =>
    items.map((i) => ({
      externalId: i.externalId,
      productId: `p-${i.externalId}`,
      variantId: `v-${i.externalId}`,
      status: "updated",
      visible: true,
      error: null,
    }));
  const base: MarketplaceConnector = {
    connect: () => Promise.reject(new Error("unused")),
    me: () => Promise.reject(new Error("unused")),
    listCategories: () => Promise.resolve([{ id: "cat-1", name: "Snacks", parentId: null }]),
    upsertItems: (items) => Promise.resolve(ok(items)),
    uploadImage: () => Promise.resolve(),
    pushStock: (moves: StockPush[]): Promise<StockPushResult[]> => {
      pushes?.push(moves);
      return Promise.resolve(
        moves.map((m) => ({
          idempotencyKey: m.idempotencyKey,
          status: "applied",
          clamped: false,
          newStockUnits: 10,
          error: null,
        })),
      );
    },
    pullStock: () => Promise.resolve({ moves: [], nextCursor: 0, epoch: "e1", watermark: 0 }),
    listRemoteItems: (): Promise<RemoteItem[]> => Promise.resolve([]),
    listPlatformProducts: () => Promise.resolve([]),
    adoptProducts: () => Promise.resolve([]),
    stockSnapshot: () => Promise.resolve({ epoch: "e1", watermark: 0, items: [] }),
    reconcileStock: () => Promise.reject(new Error("unused")),
    stockReconciliation: () => Promise.resolve(null),
  };
  return { ...base, ...rest };
}

const now = () => new Date("2026-11-05T10:00:00.000Z");

async function fixture(): Promise<{ repo: MemoryRepository; itemId: number }> {
  const repo = new MemoryRepository();
  await repo.setAppSetting("sync.stock_epoch", "e1");
  await repo.saveShopProfile({
    name: "Test shop",
    gstEnabled: false,
    pricesIncludeTax: true,
    invoicePrefix: "INV-",
    address: "",
    phone: "",
    gstin: "",
    receiptFooter: "",
    lowStockThresholdMilli: 0,
  });
  const categoryId = await repo.upsertCategory({ name: "Snacks" });
  await repo.setCategoryMarketplaceId(categoryId, "cat-1");
  const itemId = await repo.upsertItem({
    name: "Parle-G",
    barcode: "",
    categoryId,
    unitKind: "count",
    pricePaise: 1000,
    mrpPaise: 1200,
    taxRateBp: 0,
    openingStockMilli: 10_000,
    isActive: true,
  });
  await repo.recordPublish(
    [
      {
        itemId,
        state: "live",
        remoteProductId: "p-1",
        remoteVariantId: "v-1",
        contentHash: null,
      },
    ],
    new Map([[categoryId, "cat-1"]]),
  );
  return { repo, itemId };
}

describe("remote snapshot completeness", () => {
  it("rejects older potentially truncated snapshots and invalidates after publishing", async () => {
    const repo = new MemoryRepository();
    await repo.setAppSetting("remote.seen", JSON.stringify({ at: now().toISOString(), items: [] }));
    expect(await loadRemoteSeen(now(), repo)).toBeNull();
    await saveRemoteSeen([], now(), repo);
    expect(await loadRemoteSeen(now(), repo)).toEqual(new Map());
    await invalidateRemoteSeen(repo);
    expect(await loadRemoteSeen(now(), repo)).toBeNull();
  });
});

describe("remote snapshots", () => {
  it("distinguishes unavailable, empty, and populated snapshots", async () => {
    const { repo, itemId } = await fixture();
    expect(await getReconcileSnapshot(repo, now())).toBeNull();
    expect(await listReconcileRows(repo, now())).toEqual([]);
    const link = { externalId: `itm_${itemId}`, stockUnits: 10, pricePaise: 1000, remoteHash: "1000:10:1" };
    await saveRemoteSeen([link], now(), repo);
    expect(await getReconcileSnapshot(repo, now())).toEqual([]);
    await saveRemoteSeen([], now(), repo);
    expect(await loadRemoteSeen(now(), repo)).toEqual(new Map());
    expect(await getReconcileSnapshot(repo, now())).toEqual([
      expect.objectContaining({ itemId, kind: "missing_remote" }),
    ]);
  });

  it("treats expired, malformed, and unreadable snapshots as unavailable", async () => {
    const { repo } = await fixture();
    await saveRemoteSeen([], new Date(now().getTime() - 8 * 86_400_000), repo);
    expect(await loadRemoteSeen(now(), repo)).toBeNull();
    for (const raw of ["not json", '{"at":"invalid","items":[]}', '{"at":"2026-11-05T10:00:00.000Z","items":[{}]}']) {
      await repo.setAppSetting("remote.seen", raw);
      expect(await loadRemoteSeen(now(), repo)).toBeNull();
    }
    repo.getAppSetting = () => Promise.reject(new Error("read failed"));
    expect(await getReconcileSnapshot(repo, now())).toBeNull();
  });

  it("preserves the last snapshot on a remote read failure and replaces it on an empty read", async () => {
    const { repo, itemId } = await fixture();
    const link = { externalId: `itm_${itemId}`, stockUnits: 10, pricePaise: 1000, remoteHash: "1000:10:1" };
    await saveRemoteSeen([link], now(), repo);
    const failed = await runSync({ repo, connector: fakeConnector({ listRemoteItems: () => Promise.reject(new Error("offline")) }), now, isApproved: () => true }, { details: false, list: false });
    expect(failed.problems).toContain("catalog read: offline");
    expect(await loadRemoteSeen(now(), repo)).toEqual(new Map([[link.externalId, link]]));
    await runSync({ repo, connector: fakeConnector(), now, isApproved: () => true }, { details: false, list: false });
    expect(await loadRemoteSeen(now(), repo)).toEqual(new Map());
    expect(await getReconcileSnapshot(repo, now())).toEqual([expect.objectContaining({ kind: "missing_remote" })]);
  });
});

describe("runSync", () => {
  it("keeps a stock-only event run from scanning catalogs", async () => {
    const { repo } = await fixture();
    const calls: string[] = [];
    const connector = fakeConnector({
      listCategories: () => { calls.push("categories"); return Promise.resolve([]); },
      listRemoteItems: () => { calls.push("catalog"); return Promise.resolve([]); },
      pullStock: () => { calls.push("stock pull"); return Promise.resolve({ moves: [], nextCursor: 0, epoch: "e1", watermark: 0 }); },
    });
    await runSync({ repo, connector, now, isApproved: () => true }, { stockOnly: true, pullStock: false });
    expect(calls).toEqual([]);
  });

  it("continues to pull stock when loading categories fails", async () => {
    const { repo } = await fixture();
    let pulled = false;
    const connector = fakeConnector({
      listCategories: () => Promise.reject(new Error("offline")),
      pullStock: () => { pulled = true; return Promise.resolve({ moves: [], nextCursor: 0, epoch: "e1", watermark: 0 }); },
    });
    const result = await runSync({ repo, connector, now, isApproved: () => true });
    expect(pulled).toBe(true);
    expect(result.problems).toContain("catalog: offline");
  });

  it("follows a stock continuation and stops at the final page", async () => {
    const { repo, itemId } = await fixture();
    // A linked item must already hold a baseline in the active epoch before feed moves apply.
    (repo as unknown as { stockStates: Map<string, unknown> }).stockStates.set(`itm_${itemId}`, { externalId: `itm_${itemId}`, variantId: "v", epoch: "e1", sequence: 0, revision: 0, generation: 1, stockUnits: 0 });
    const calls: { cursor: number; continuation?: string }[] = [];
    const connector = fakeConnector({
      pullStock: (cursor, options) => {
        calls.push({ cursor, continuation: options?.continuation });
        return Promise.resolve(cursor === 0
          ? { moves: [{ id: 1, sequence: 1, revision: 1, epoch: "e1", externalId: `itm_${itemId}`, deltaUnits: -1, reason: "online_order", createdAt: now().toISOString() }], nextCursor: 1, epoch: "e1", watermark: 1, hasMore: true, continuation: "next" }
          : { moves: [{ id: 2, sequence: 2, revision: 1, epoch: "e1", externalId: `itm_${itemId}`, deltaUnits: -1, reason: "online_order", createdAt: now().toISOString() }], nextCursor: 2, epoch: "e1", watermark: 2, hasMore: false });
      },
    });
    const result = await runSync({ repo, connector, now, isApproved: () => true }, { stockOnly: true });
    expect(calls).toEqual([{ cursor: 0, continuation: undefined }, { cursor: 1, continuation: "next" }]);
    expect(result.problems).toEqual([]);
    expect(await repo.getSyncCursor("stock")).toBe("2");
  });

  it("records rate limiting as a scheduled stock retry", async () => {
    const { repo } = await fixture();
    const connector = fakeConnector({ pullStock: () => Promise.reject(new MarketplaceError("rate_limited", "wait", 429, 37)) });
    const result = await runSync({ repo, connector, now, isApproved: () => true }, { stockOnly: true });
    expect(result.retryAfterSeconds).toBe(37);
    expect(result.problems).toEqual([]);
  });

  it("marks stock bootstrap required when stock pull encounters a 409 conflict or epoch mismatch", async () => {
    const { repo } = await fixture();
    const connector = fakeConnector({
      pullStock: () => Promise.reject(new MarketplaceError("bootstrap_required", "A coherent snapshot is required for this feed epoch.", 409)),
    });
    const result = await runSync({ repo, connector, now, isApproved: () => true }, { stockOnly: true });
    expect(result.problems[0]).toContain("A coherent snapshot is required for this feed epoch");
    expect(await repo.getAppSetting("sync.stock_bootstrap_required")).toBe("true");
  });

  it("surfaces a marketplace clamp even when the movement is accepted", async () => {
    const { repo, itemId } = await fixture();
    await repo.adjustStock(itemId, -1000, "adjustment");
    const connector = fakeConnector({
      pushStock: (moves) => Promise.resolve(moves.map((move) => ({
        idempotencyKey: move.idempotencyKey, status: "applied" as const,
        clamped: true, newStockUnits: 0, error: null,
      }))),
    });
    const result = await runSync({ repo, connector, now, isApproved: () => true }, { stockOnly: true, pullStock: false });
    expect(result.problems.join(" ")).toContain("clamped or unknown");
    expect(await repo.listOutbox("pending")).toHaveLength(0);
    expect(await repo.listOutbox("quarantined")).toHaveLength(1);
    await saveRemoteSeen([{ externalId: `itm_${itemId}`, stockUnits: 9, pricePaise: 1000, remoteHash: "1000:9:1" }], now(), repo);
    expect(await getReconcileSnapshot(repo, now())).toContainEqual(expect.objectContaining({ kind: "stock", localValue: 9, remoteValue: 9 }));
  });

  it("reports unknown historical clamp status for accepted duplicates", async () => {
    const { repo, itemId } = await fixture();
    await repo.adjustStock(itemId, -1000, "adjustment");
    const connector = fakeConnector({
      pushStock: (moves) => Promise.resolve(moves.map((move) => ({
        idempotencyKey: move.idempotencyKey, status: "duplicate" as const,
        clamped: null, newStockUnits: 0, error: null,
      }))),
    });
    const result = await runSync({ repo, connector, now, isApproved: () => true }, { stockOnly: true, pullStock: false });
    expect(result.problems.join(" ")).toContain("clamped or unknown");
    expect(await repo.listOutbox("pending")).toHaveLength(0);
    expect(await repo.listOutbox("quarantined")).toHaveLength(1);
  });

  it("sends opposite-sign movements in order without netting them", async () => {
    const { repo, itemId } = await fixture();
    await repo.adjustStock(itemId, -1000, "adjustment");
    await repo.adjustStock(itemId, 1000, "adjustment");
    const pushes: StockPush[][] = [];
    const result = await runSync({ repo, connector: fakeConnector({ pushes }), now, isApproved: () => true }, { stockOnly: true, pullStock: false });
    expect(pushes.flat().map((move) => move.deltaUnits)).toEqual([-1, 1]);
    expect(new Set(pushes.flat().map((move) => move.idempotencyKey)).size).toBe(2);
    expect(await repo.listOutbox("pending")).toHaveLength(0);
    expect(result.problems).toEqual([]);
  });

  it("does not retry an item before its outbox backoff expires", async () => {
    const { repo, itemId } = await fixture();
    await repo.adjustStock(itemId, -1000, "adjustment");
    let attempts = 0;
    const connector = fakeConnector({
      pushStock: () => { attempts++; return Promise.reject(new Error("offline")); },
    });
    await runSync({ repo, connector, now, isApproved: () => true }, { stockOnly: true, pullStock: false });
    await repo.adjustStock(itemId, -1000, "adjustment");
    await runSync({ repo, connector, now, isApproved: () => true }, { stockOnly: true, pullStock: false });
    expect(attempts).toBe(1);
    expect(await repo.listOutbox("pending")).toHaveLength(2);
  });

  it("sends repeated sources separately and clears only their exact outbox rows", async () => {
    const { repo, itemId } = await fixture();
    await repo.adjustStock(itemId, -1000, "adjustment");
    await repo.adjustStock(itemId, -1000, "adjustment");
    const pushes: StockPush[][] = [];

    const outcome = await runSync({
      repo,
      connector: fakeConnector({ pushes }),
      now,
      isApproved: () => true,
    });

    expect(pushes).toHaveLength(2);
    expect(pushes.flat().map((move) => move.deltaUnits)).toEqual([-1, -1]);
    expect(pushes.flat().every((move) => move.reason === "adjustment")).toBe(true);
    expect(outcome.problems).toEqual([]);
    expect(await repo.listOutbox("pending")).toEqual([]);
  });

  it("replays identical immutable requests after response loss while preserving newer sources", async () => {
    const { repo, itemId } = await fixture();
    await repo.adjustStock(itemId, -1000, "adjustment");
    const sent: StockPush[] = [];
    let lost = true;
    const connector = fakeConnector({ pushStock: async (moves) => {
      sent.push(...structuredClone(moves));
      if (lost) { lost = false; throw new Error("response lost after apply"); }
      return moves.map((move) => ({ idempotencyKey: move.idempotencyKey, status: "duplicate", clamped: false, newStockUnits: 9, error: null }));
    } });
    await runSync({ repo, connector, now, isApproved: () => true }, { stockOnly: true, pullStock: false });
    await repo.adjustStock(itemId, -1000, "adjustment");
    await runSync({ repo, connector, now: () => new Date(now().getTime() + 3_600_000), isApproved: () => true }, { stockOnly: true, pullStock: false });
    expect(sent).toHaveLength(3);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[2]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    expect(await repo.listOutbox("pending")).toEqual([]);
  });

  it("leaves a failed local settlement recoverable under the same key", async () => {
    const { repo, itemId } = await fixture();
    await repo.adjustStock(itemId, -1000, "adjustment");
    const pushes: StockPush[][] = [];
    const settle = repo.settleStockDelivery.bind(repo);
    repo.settleStockDelivery = async () => { throw new Error("disk unavailable"); };
    await expect(runSync({ repo, connector: fakeConnector({ pushes }), now, isApproved: () => true }, { stockOnly: true, pullStock: false })).rejects.toThrow("disk unavailable");
    expect(await repo.listOutbox("pending")).toHaveLength(1);
    repo.settleStockDelivery = settle;
    await runSync({ repo, connector: fakeConnector({ pushes }), now: () => new Date(now().getTime() + 180_000), isApproved: () => true }, { stockOnly: true, pullStock: false });
    expect(pushes[1]).toEqual(pushes[0]);
    expect(await repo.listOutbox("pending")).toEqual([]);
  });

  it("bounds a run even when each in-flight delivery creates another sale", async () => {
    const { repo, itemId } = await fixture();
    await repo.adjustStock(itemId, -1000, "adjustment");
    let calls = 0;
    const connector = fakeConnector({ pushStock: async (moves) => {
      calls++;
      await repo.adjustStock(itemId, -1000, "adjustment");
      return moves.map((move) => ({ idempotencyKey: move.idempotencyKey, status: "applied", clamped: false, newStockUnits: 1, error: null }));
    } });
    const result = await runSync({ repo, connector, now, isApproved: () => true }, { stockOnly: true, pullStock: false, bulkMax: 3 });
    expect(calls).toBe(3);
    expect(result.pushedMoves).toBe(3);
    expect(await repo.listOutbox("pending")).toHaveLength(1);
  });

  it("does not release the opposite-sign successor after a clamped predecessor", async () => {
    const { repo, itemId } = await fixture();
    await repo.adjustStock(itemId, -1000, "adjustment");
    await repo.adjustStock(itemId, 1000, "adjustment");
    const sent: StockPush[] = [];
    const connector = fakeConnector({ pushStock: async (moves) => {
      sent.push(...moves);
      return moves.map((move) => ({ idempotencyKey: move.idempotencyKey, status: "applied", clamped: true, newStockUnits: 0, error: null }));
    } });
    await runSync({ repo, connector, now, isApproved: () => true }, { stockOnly: true, pullStock: false });
    expect(sent.map((move) => move.deltaUnits)).toEqual([-1]);
    expect(await repo.listOutbox("quarantined")).toHaveLength(1);
    expect(await repo.listOutbox("pending")).toHaveLength(1);
  });

  it("with details off, sends and pulls no stock or edits to linked items", async () => {
    const { repo, itemId } = await fixture();
    await repo.setItemPhoto(itemId, new Uint8Array([0xff, 0xd8, 0xff]), "h1");
    await repo.adjustStock(itemId, -1000, "adjustment");
    const pushes: StockPush[][] = [];
    let upserts = 0;
    let pulls = 0;
    const connector = fakeConnector({
      pushes,
      upsertItems: (items) => {
        upserts += items.length;
        return Promise.resolve([]);
      },
      pullStock: () => {
        pulls += 1;
        return Promise.resolve({ moves: [], nextCursor: 0, epoch: "e1", watermark: 0 });
      },
    });
    await runSync({ repo, connector, now, isApproved: () => true }, { details: false });
    expect(pushes).toHaveLength(0);
    expect(upserts).toBe(0);
    expect(pulls).toBe(0);
  });

  it("with the list off, linked items are still updated", async () => {
    const { repo, itemId } = await fixture();
    await repo.setItemPhoto(itemId, new Uint8Array([0xff, 0xd8, 0xff]), "h1");
    let upserts = 0;
    const connector = fakeConnector({
      upsertItems: (items) => {
        upserts += items.length;
        return Promise.resolve([]);
      },
    });
    await runSync({ repo, connector, now, isApproved: () => true }, { list: false });
    expect(upserts).toBe(1);
  });

  it("takes a price changed on MyTownCart, but never overwrites a local edit", async () => {
    const { repo, itemId } = await fixture();
    const remote = (price: number): RemoteItem => ({
      externalId: `itm_${itemId}`,
      productId: "p-1",
      variantId: "v-1",
      stockUnits: 10,
      pricePaise: price,
      isActive: true,
    });
    const run = (price: number) =>
      runSync(
        { repo, connector: fakeConnector({ listRemoteItems: () => Promise.resolve([remote(price)]) }), now, isApproved: () => true },
        { list: false },
      );
    await run(1000); // first look: remote 1000 == local 1000
    const out = await run(1500); // edited on MyTownCart
    expect(out.pulledPrices).toBe(1);
    expect((await repo.listItems({ activeOnly: false }))[0]?.pricePaise).toBe(1500);
    await repo.upsertItem({ id: itemId, name: "Parle-G", barcode: "", categoryId: null, unitKind: "count", pricePaise: 1800, mrpPaise: 1200, taxRateBp: 0, openingStockMilli: 10_000, isActive: true });
    const out2 = await run(2000); // both changed → local wins
    expect(out2.pulledPrices).toBeUndefined();
    expect((await repo.listItems({ activeOnly: false }))[0]?.pricePaise).toBe(1800);
  });

  it("takes a description changed on MyTownCart unless it was also edited here", async () => {
    const { repo, itemId } = await fixture();
    const remote = (description: string): RemoteItem => ({
      externalId: `itm_${itemId}`,
      productId: "p-1",
      variantId: "v-1",
      stockUnits: 10,
      pricePaise: 1000,
      isActive: true,
      description,
    });
    const run = (description: string) =>
      runSync(
        { repo, connector: fakeConnector({ listRemoteItems: () => Promise.resolve([remote(description)]) }), now, isApproved: () => true },
        { list: false },
      );
    const local = async () => (await repo.listItems({ activeOnly: false }))[0]?.description;
    await run("<p>Crisp</p>"); // first look records it, nothing is pulled
    expect(await local()).not.toBe("<p>Crisp</p>");
    const out = await run("<p>Crisp <strong>and sweet</strong></p>"); // edited on MyTownCart
    expect(out.pulledDescriptions).toBe(1);
    expect(await local()).toBe("<p>Crisp <strong>and sweet</strong></p>");
    const out2 = await run("<p>Crisp <strong>and sweet</strong></p>"); // nothing new
    expect(out2.pulledDescriptions).toBeUndefined();
    await repo.upsertItem({ id: itemId, name: "Parle-G", barcode: "", categoryId: null, unitKind: "count", pricePaise: 1000, mrpPaise: 1200, taxRateBp: 0, openingStockMilli: 10_000, isActive: true, description: "<p>Mine</p>" });
    const out3 = await run("<p>Theirs</p>"); // both changed → local wins
    expect(out3.pulledDescriptions).toBeUndefined();
    expect(await local()).toBe("<p>Mine</p>");
  });

  it("sends an explicit clear only when a description that had text was emptied here", async () => {
    const { repo, itemId } = await fixture();
    await repo.setItemPhoto(itemId, new Uint8Array([0xff, 0xd8, 0xff]), "h1");
    const sent: { description?: string; clearDescription?: boolean }[] = [];
    const remote: RemoteItem = {
      externalId: `itm_${itemId}`,
      productId: "p-1",
      variantId: "v-1",
      stockUnits: 10,
      pricePaise: 1000,
      isActive: true,
      description: "<p>Crisp</p>",
    };
    const connector = fakeConnector({
      listRemoteItems: () => Promise.resolve([remote]),
      upsertItems: (items) => {
        sent.push(...items);
        return Promise.resolve(
          items.map((i) => ({ externalId: i.externalId, productId: "p-1", variantId: "v-1", status: "updated" as const, visible: true, error: null })),
        );
      },
    });
    const run = () => runSync({ repo, connector, now, isApproved: () => true }, { list: false });
    const edit = async (description: string) => {
      const cur = (await repo.listItems({ activeOnly: false }))[0]!;
      await repo.upsertItem({ id: itemId, name: cur.name, barcode: cur.barcode, categoryId: cur.categoryId, unitKind: cur.unitKind, pricePaise: cur.pricePaise, mrpPaise: cur.mrpPaise, taxRateBp: cur.taxRateBp, openingStockMilli: 0, isActive: cur.isActive, description });
    };
    await run(); // first look: records the remote text, local is empty
    expect(sent.every((i) => !i.clearDescription)).toBe(true); // never had text here → no clear
    await edit("<p>Mine</p>");
    await run();
    sent.length = 0;
    await edit("");
    await run();
    expect(sent.some((i) => i.clearDescription === true)).toBe(true);
  });

  it("takes a name changed on MyTownCart unless it was also edited here", async () => {
    const { repo, itemId } = await fixture();
    const remote = (name: string): RemoteItem => ({
      externalId: `itm_${itemId}`,
      productId: "p-1",
      variantId: "v-1",
      stockUnits: 10,
      pricePaise: 1000,
      isActive: true,
      name,
    });
    const run = (name: string) =>
      runSync(
        { repo, connector: fakeConnector({ listRemoteItems: () => Promise.resolve([remote(name)]) }), now, isApproved: () => true },
        { list: false },
      );
    await run("Parle-G"); // first look records the name
    const out = await run("Parle-G Gold"); // renamed on MyTownCart
    expect(out.pulledNames).toBe(1);
    expect((await repo.listItems({ activeOnly: false }))[0]?.name).toBe("Parle-G Gold");
    await repo.upsertItem({ id: itemId, name: "Parle Biscuit", barcode: "", categoryId: null, unitKind: "count", pricePaise: 1000, mrpPaise: 1200, taxRateBp: 0, openingStockMilli: 10_000, isActive: true });
    const out2 = await run("Parle Other"); // both changed → local wins
    expect(out2.pulledNames).toBeUndefined();
    expect((await repo.listItems({ activeOnly: false }))[0]?.name).toBe("Parle Biscuit");
  });

  it("records the marketplace catalog snapshot", async () => {
    const { repo } = await fixture();
    const outcome = await runSync({
      repo,
      connector: fakeConnector({
        listRemoteItems: () =>
          Promise.resolve([
            { externalId: "itm_1", productId: "p", variantId: "v", stockUnits: 9, pricePaise: 1000, isActive: true },
          ]),
      }),
      now,
      isApproved: () => true,
    });
    expect(outcome.problems).toEqual([]);
  });

  it("reports a failing step without losing the others", async () => {
    const { repo } = await fixture();
    const outcome = await runSync({
      repo,
      connector: fakeConnector({
        listRemoteItems: () => Promise.reject(new Error("boom")),
      }),
      now,
      isApproved: () => true,
    });
    expect(outcome.problems).toEqual(["catalog read: boom"]);
  });

  it("passes force option to pullStock", async () => {
    const { repo } = await fixture();
    let pullStockOpts: { force?: boolean } | undefined;
    await runSync(
      {
        repo,
        connector: fakeConnector({
          pullStock: (_c, opts) => {
            pullStockOpts = opts;
            return Promise.resolve({ moves: [], nextCursor: 0, epoch: "e1", watermark: 0 });
          },
        }),
        now,
        isApproved: () => true,
      },
      { force: true },
    );
    expect(pullStockOpts).toMatchObject({ force: true, epoch: "e1" });
  });

  it("generates non-empty remoteHash when recording remote catalog items", async () => {
    const { repo, itemId } = await fixture();
    await runSync({
      repo,
      connector: fakeConnector({
        listRemoteItems: () =>
          Promise.resolve([
            {
              externalId: `itm_${itemId}`,
              productId: "p-1",
              variantId: "v-1",
              stockUnits: 5,
              pricePaise: 1200,
              isActive: true,
            },
          ]),
      }),
      now,
      isApproved: () => true,
    });
    const items = await repo.listItems({ activeOnly: false });
    const item = items.find((i) => i.id === itemId);
    expect(item?.remoteHash).toBe("1200:5:1");
  });

  it("reads the MyTownCart-only products only when asked, and reports a failed read", async () => {
    const { repo } = await fixture();
    let reads = 0;
    const connector = fakeConnector({
      listPlatformProducts: () => {
        reads += 1;
        return Promise.reject(new Error("boom"));
      },
    });
    const quiet = await runSync({ repo, connector, now, isApproved: () => true });
    expect(reads).toBe(0);
    expect(quiet.problems).toEqual([]);
    const asked = await runSync({ repo, connector, now, isApproved: () => true }, { platformOnly: true });
    expect(reads).toBe(1);
    expect(asked.problems).toEqual(["platform read: boom"]);
  });
});
