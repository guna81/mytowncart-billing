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
