// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type {
  MarketplaceConnector,
  RemoteOrder,
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
    pullOrders: (): Promise<{ orders: RemoteOrder[]; next?: string }> =>
      Promise.resolve({ orders: [] }),
    listRemoteItems: (): Promise<RemoteItem[]> => Promise.resolve([]),
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

  it("records the marketplace catalog snapshot and orders", async () => {
    const { repo } = await fixture();
    const outcome = await runSync({
      repo,
      connector: fakeConnector({
        listRemoteItems: () =>
          Promise.resolve([
            { externalId: "itm_1", productId: "p", variantId: "v", stockUnits: 9, pricePaise: 1000, isActive: true },
          ]),
        pullOrders: () =>
          Promise.resolve({
            orders: [
              {
                id: "ORD-1",
                status: "confirmed",
                paymentStatus: "paid",
                paymentMethod: "online",
                totalPaise: 2050,
                placedAt: "2026-11-05T09:00:00Z",
                updatedAt: "2026-11-05T09:00:00Z",
                lines: [{ externalId: "itm_1", productName: "Parle-G", qtyUnits: 2, unitPricePaise: 1000 }],
              },
            ],
          }),
      }),
      now,
      isApproved: () => true,
    });
    expect(outcome.orders).toBe(1);
    expect(outcome.problems).toEqual([]);
    const orders = await repo.listRemoteOrders();
    expect(orders[0]).toMatchObject({ id: "ORD-1", totalPaise: 2050 });
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

  it("passes force option to pullStock and pullOrders", async () => {
    const { repo } = await fixture();
    let pullStockOpts: { force?: boolean } | undefined;
    let pullOrdersOpts: { force?: boolean } | undefined;
    await runSync(
      {
        repo,
        connector: fakeConnector({
          pullStock: (_c, opts) => {
            pullStockOpts = opts;
            return Promise.resolve({ moves: [], nextCursor: 0 });
          },
          pullOrders: (_a, opts) => {
            pullOrdersOpts = opts;
            return Promise.resolve({ orders: [] });
          },
        }),
        now,
        isApproved: () => true,
      },
      { force: true },
    );
    expect(pullStockOpts).toEqual({ force: true });
    expect(pullOrdersOpts).toEqual({ force: true });
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
});
