// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type {
  MarketplaceConnector,
  RemoteItem,
  StockPush,
  StockPushResult,
  UpsertResult,
  PublishItem,
} from "@mytowncart-billing/connector-mytowncart";
import { MemoryRepository } from "@mytowncart-billing/storage";

import { netDeltas, runSync } from "./syncEngine";

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
    pullStock: () => Promise.resolve({ moves: [], nextCursor: 0 }),
    listRemoteItems: (): Promise<RemoteItem[]> => Promise.resolve([]),
    listPlatformProducts: () => Promise.resolve([]),
    adoptProducts: () => Promise.resolve([]),
  };
  return { ...base, ...rest };
}

const now = () => new Date("2026-11-05T10:00:00.000Z");

async function fixture(): Promise<{ repo: MemoryRepository; itemId: number }> {
  const repo = new MemoryRepository();
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

describe("netDeltas", () => {
  it("sums the signed deltas per item", () => {
    const rows = [
      { id: 1, idempotencyKey: "a", externalId: "itm_1", deltaUnits: -1, reason: "sale", attempts: 0, nextAttemptAt: null, status: "pending" },
      { id: 2, idempotencyKey: "b", externalId: "itm_1", deltaUnits: -2, reason: "sale", attempts: 0, nextAttemptAt: null, status: "pending" },
      { id: 3, idempotencyKey: "c", externalId: "itm_2", deltaUnits: 5, reason: "adjustment", attempts: 0, nextAttemptAt: null, status: "pending" },
    ] as const;
    expect([...netDeltas(rows)]).toEqual([
      ["itm_1", -3],
      ["itm_2", 5],
    ]);
  });
});

describe("runSync", () => {
  it("merges repeated sales into one push and clears the outbox", async () => {
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

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toHaveLength(1);
    // The outbox is written by the Tauri repo; the memory repo has no outbox
    // writer, so this checks the zero-row path stays harmless.
    expect(outcome.problems).toEqual([]);
    expect(await repo.listOutbox("pending")).toEqual([]);
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
        return Promise.resolve({ moves: [], nextCursor: 0 });
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
            return Promise.resolve({ moves: [], nextCursor: 0 });
          },
        }),
        now,
        isApproved: () => true,
      },
      { force: true },
    );
    expect(pullStockOpts).toEqual({ force: true });
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
