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
