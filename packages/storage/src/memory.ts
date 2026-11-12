// SPDX-License-Identifier: Apache-2.0
/**
 * In-memory adapter implementing the same repository semantics as the Rust
 * shell (invoice counters per (fy, prefix), compensating void movements,
 * cached stock = ledger sum, per-row CSV import isolation). Used by Vitest
 * and by the web UI when it is NOT running inside Tauri (plain-browser dev
 * and Playwright).
 */

import { formatInvoiceNumber, localIsoTimestamp, sortBatchesFifo, type ReportBill } from "@mytowncart-billing/core";
import { setSessionToken } from "./session";
import { buildCustomerLedger, creditNoteCashRefunds, type LedgerBill } from "./ledger";
import type {
  BillingRepository,
  BillFilter,
  CreatedBill,
  ItemFilter,
  NewBillPayload,
} from "./repository";
import type {
  AuditLog,
  AuditLogInput,
  BarcodeLookupResult,
  BatchInput,
  BillDetail,
  BillLineRow,
  BillSummary,
  Category,
  CreditNote,
  CreditNoteLine,
  Customer,
  CustomerInput,
  CustomerLedgerSummary,
  CustomerPayment,
  CustomerPaymentInput,
  DayEndClosure,
  DayEndClosureInput,
  DayEndExpectedCash,
  HeldBill,
  HeldBillInput,
  ImportRowOutcome,
  Item,
  ItemBarcode,
  ItemBatch,
  ItemImage,
  ItemInput,
  LoyaltyTransaction,
  NewCreditNotePayload,
  NewPurchasePayload,
  OutboxRow,
  PaymentRow,
  PublishOutcome,
  Purchase,
  PurchaseLine,
  ReconcileFix,
  RemoteItemLink,
  ShopProfile,
  StockDiscrepancyInput,
  StockMovementRecord,
  Supplier,
  SupplierInput,
  User,
  UserInput,
  UserRole,
} from "./types";

interface MemoryPhoto {
  bytes: Uint8Array;
  imageHash: string;
}

export class MemoryRepository implements BillingRepository {
  readonly kind = "memory" as const;

  private shopProfile: ShopProfile | null = null;
  private categories = new Map<number, Category>();
  private items = new Map<number, Item>();
  private customers = new Map<number, Customer>();
  private customerPayments: CustomerPayment[] = [];
  private bills = new Map<number, BillDetail>();
  private creditNotes = new Map<number, CreditNote>();
  private suppliers = new Map<number, Supplier>();
  private purchases = new Map<number, Purchase>();
  private users = new Map<number, User>();
  /** PINs by user id — kept apart from `User`, which only exposes `hasPin`. */
  private pins = new Map<number, string>();
  private auditLogs: AuditLog[] = [];
  private batches = new Map<number, ItemBatch>();
  private loyaltyTransactions: LoyaltyTransaction[] = [];
  private itemBarcodes = new Map<number, ItemBarcode>();
  private dayEndClosures = new Map<number, DayEndClosure>();
  private movements: StockMovementRecord[] = [];
  private invoiceCounters = new Map<string, number>(); // `${fy}${prefix}` -> next seq
  private nextIds = {
    category: 1, item: 1, customer: 1, customerPayment: 1, bill: 1, line: 1, payment: 1, movement: 1, held: 1,
    outbox: 1, creditNote: 1, creditNoteLine: 1, supplier: 1, purchase: 1, purchaseLine: 1, user: 1, auditLog: 1,
    batch: 1, loyaltyTx: 1, itemBarcode: 1, dayEndClosure: 1, itemImage: 1,
  };
  private photos = new Map<number, MemoryPhoto>();
  private itemImages = new Map<number, ItemImage>();
  private imageBytes = new Map<number, Uint8Array>();
  private held = new Map<number, HeldBill>();
  private outbox: OutboxRow[] = [];
  private cursors = new Map<string, string>();
  private appSettings = new Map<string, string>();

  async getShopProfile(): Promise<ShopProfile | null> {
    return this.shopProfile;
  }

  async saveShopProfile(
    profile: Omit<ShopProfile, "updatedAt"> & { updatedAt?: string },
  ): Promise<void> {
    this.shopProfile = { ...profile, updatedAt: profile.updatedAt ?? localIsoTimestamp(new Date()) };
  }

  async listCategories(): Promise<Category[]> {
    return [...this.categories.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async upsertCategory(input: { id?: number; name: string }): Promise<number> {
    if (input.name.trim() === "") throw new Error("category name is required");
    if (input.id !== undefined) {
      const existing = this.categories.get(input.id);
      if (!existing) throw new Error(`no category with id ${input.id}`);
      existing.name = input.name;
      return input.id;
    }
    const byName = [...this.categories.values()].find((c) => c.name === input.name);
    if (byName) return byName.id;
    const id = this.nextIds.category++;
    this.categories.set(id, { id, name: input.name, marketplaceCategoryId: null });
    return id;
  }

  async setCategoryMarketplaceId(
    categoryId: number,
    marketplaceCategoryId: string | null,
  ): Promise<void> {
    const category = this.categories.get(categoryId);
    if (!category) throw new Error(`no category with id ${categoryId}`);
    category.marketplaceCategoryId = marketplaceCategoryId;
  }

  async recordPublish(
    outcomes: readonly PublishOutcome[],
    marketplaceCategoryIds: ReadonlyMap<number, string>,
  ): Promise<void> {
    for (const [categoryId, marketplaceCategoryId] of marketplaceCategoryIds) {
      const category = this.categories.get(categoryId);
      if (category) category.marketplaceCategoryId = marketplaceCategoryId;
    }
    for (const outcome of outcomes) {
      const item = this.items.get(outcome.itemId);
      if (!item) continue;
      item.publishState = outcome.state;
      item.remoteProductId = outcome.remoteProductId;
      item.remoteVariantId = outcome.remoteVariantId;
      item.contentHash = outcome.contentHash;
    }
  }

  private categoryName(categoryId: number | null): string | null {
    return categoryId === null ? null : (this.categories.get(categoryId)?.name ?? null);
  }

  async listItems(filter?: ItemFilter): Promise<Item[]> {
    let rows = [...this.items.values()];
    if (filter?.activeOnly !== false) rows = rows.filter((i) => i.isActive);
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      rows = rows.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.barcode.toLowerCase().includes(q) ||
          (i.brand && i.brand.toLowerCase().includes(q)) ||
          (i.description && i.description.toLowerCase().includes(q)) ||
          (i.customAttributes &&
            Object.entries(i.customAttributes).some(
              ([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q),
            )),
      );
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getItem(id: number): Promise<Item | null> {
    return this.items.get(id) ?? null;
  }

  async findItemByBarcode(barcode: string): Promise<Item | null> {
    if (barcode === "") return null;
    return (
      [...this.items.values()].find((i) => i.barcode === barcode && i.isActive) ?? null
    );
  }

  private insertOrUpdateItem(input: ItemInput): number {
    if (input.name.trim() === "") throw new Error("item name is required");
    if (input.pricePaise < 0 || input.mrpPaise < 0) throw new Error("price/mrp must be >= 0");
    const now = localIsoTimestamp(new Date());
    if (input.id !== undefined) {
      const existing = this.items.get(input.id);
      if (!existing) throw new Error(`no item with id ${input.id}`);
      Object.assign(existing, {
        name: input.name,
        barcode: input.barcode,
        categoryId: input.categoryId,
        categoryName: this.categoryName(input.categoryId),
        unitKind: input.unitKind,
        pricePaise: input.pricePaise,
        mrpPaise: input.mrpPaise,
        taxRateBp: input.taxRateBp,
        isActive: input.isActive,
        hsnCode: input.hsnCode ?? existing.hsnCode ?? "",
        costPricePaise: input.costPricePaise ?? existing.costPricePaise ?? 0,
        description: input.description !== undefined ? input.description : (existing.description ?? ""),
        brand: input.brand !== undefined ? input.brand : (existing.brand ?? ""),
        customAttributes:
          input.customAttributes !== undefined ? { ...input.customAttributes } : (existing.customAttributes ?? {}),
        variantGroup: input.variantGroup ?? existing.variantGroup ?? "",
        variantOptions: input.variantOptions ? { ...input.variantOptions } : (existing.variantOptions ?? {}),
        updatedAt: now,
      });
      return input.id;
    }
    // Same rule as the Rust shell: a known barcode re-import updates the item.
    if (input.barcode !== "") {
      const existing = [...this.items.values()].find((i) => i.barcode === input.barcode);
      if (existing) {
        return this.insertOrUpdateItem({ ...input, id: existing.id, openingStockMilli: 0 });
      }
    }
    const id = this.nextIds.item++;
    this.items.set(id, {
      id,
      name: input.name,
      barcode: input.barcode,
      categoryId: input.categoryId,
      categoryName: this.categoryName(input.categoryId),
      unitKind: input.unitKind,
      pricePaise: input.pricePaise,
      mrpPaise: input.mrpPaise,
      taxRateBp: input.taxRateBp,
      stockMilli: 0,
      isActive: input.isActive,
      photoPath: "",
      publishState: "local_only",
      remoteProductId: null,
      remoteVariantId: null,
      contentHash: null,
      photoFile: "",
      imageHash: null,
      imageUploadedAt: null,
      remoteHash: null,
      hsnCode: input.hsnCode ?? "",
      costPricePaise: input.costPricePaise ?? 0,
      description: input.description ?? "",
      brand: input.brand ?? "",
      customAttributes: input.customAttributes ? { ...input.customAttributes } : {},
      variantGroup: input.variantGroup ?? "",
      variantOptions: input.variantOptions ? { ...input.variantOptions } : {},
      updatedAt: now,
    });
    if (input.openingStockMilli !== 0) {
      this.recordMovement(id, input.openingStockMilli, "opening", null, null);
    }
    return id;
  }

  async upsertItem(input: ItemInput): Promise<number> {
    return this.insertOrUpdateItem(input);
  }

  async importItems(items: ItemInput[]): Promise<ImportRowOutcome[]> {
    return items.map((input, index) => {
      try {
        return { index, ok: true, id: this.insertOrUpdateItem(input) };
      } catch (e) {
        return { index, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  async listCustomers(search?: string): Promise<Customer[]> {
    let rows = [...this.customers.values()];
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((c) => c.name.toLowerCase().includes(q) || c.phone.includes(search));
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async upsertCustomer(input: CustomerInput): Promise<number> {
    if (input.name.trim() === "") throw new Error("customer name is required");
    const now = localIsoTimestamp(new Date());
    if (input.id !== undefined) {
      const existing = this.customers.get(input.id);
      if (!existing) throw new Error(`no customer with id ${input.id}`);
      existing.name = input.name;
      existing.phone = input.phone;
      existing.gstin = input.gstin ?? existing.gstin ?? "";
      existing.address = input.address ?? existing.address ?? "";
      existing.updatedAt = now;
      return input.id;
    }
    const id = this.nextIds.customer++;
    this.customers.set(id, {
      id,
      name: input.name,
      phone: input.phone,
      gstin: input.gstin ?? "",
      address: input.address ?? "",
      loyaltyPoints: 0,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async deleteCustomer(id: number): Promise<boolean> {
    // Check if customer has bills
    const hasBills = [...this.bills.values()].some((b) => b.customerId === id);
    if (hasBills) {
      throw new Error("cannot delete customer with existing bills");
    }
    const hasPayments = this.customerPayments.some((p) => p.customerId === id);
    if (hasPayments) {
      throw new Error("cannot delete customer with existing payment records");
    }
    return this.customers.delete(id);
  }

  async recordCustomerPayment(input: CustomerPaymentInput): Promise<number> {
    if (input.amountPaise <= 0) throw new Error("payment amount must be positive");
    const customer = this.customers.get(input.customerId);
    if (!customer) throw new Error(`no customer with id ${input.customerId}`);
    const owed = (await this.getCustomerLedger(input.customerId)).outstandingBalancePaise;
    if (input.amountPaise > owed) throw new Error("payment is more than the customer owes");
    const id = this.nextIds.customerPayment++;
    const payment: CustomerPayment = {
      id,
      customerId: input.customerId,
      amountPaise: input.amountPaise,
      mode: input.mode,
      notes: input.notes ?? "",
      createdAt: input.createdAt ?? localIsoTimestamp(new Date()),
    };
    this.customerPayments.push(payment);
    return id;
  }

  async listCustomerPayments(customerId: number): Promise<CustomerPayment[]> {
    return this.customerPayments
      .filter((p) => p.customerId === customerId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  }

  async getCustomerLedger(customerId: number): Promise<CustomerLedgerSummary> {
    const customer = this.customers.get(customerId);
    if (!customer) throw new Error(`no customer with id ${customerId}`);
    const bills: LedgerBill[] = [...this.bills.values()]
      .filter((b) => b.customerId === customerId && b.status === "active")
      .map((b) => ({
        id: b.id,
        number: b.number,
        createdAt: b.createdAt,
        creditPaise: b.payments.filter((p) => p.mode === "credit").reduce((s, p) => s + p.amountPaise, 0),
      }));
    const billIds = new Set(bills.map((b) => b.id));
    const notes = [...this.creditNotes.values()].filter((n) => billIds.has(n.billId));
    return buildCustomerLedger(customer, bills, await this.listCustomerPayments(customerId), notes);
  }

  private recordMovement(
    itemId: number,
    deltaMilli: number,
    reason: StockMovementRecord["reason"],
    refType: StockMovementRecord["refType"],
    refId: string | null,
  ): number {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`no item with id ${itemId}`);
    const id = this.nextIds.movement++;
    this.movements.push({
      id,
      itemId,
      deltaMilli,
      reason,
      refType,
      refId,
      createdAt: localIsoTimestamp(new Date()),
    });
    item.stockMilli += deltaMilli;
    // Mirrors the Tauri repo: only published items with real sales/adjustments
    // are pushed, and each movement's key is stable for idempotent retries.
    const remoteReason =
      reason === "sale" ? "sale" : reason === "void" ? "order_cancel" : reason === "adjustment" ? "adjustment" : null;
    if (
      item.remoteProductId !== null &&
      deltaMilli !== 0 &&
      deltaMilli % 1000 === 0 &&
      remoteReason !== null
    ) {
      const key =
        refType === "bill" && refId !== null ? `bill:${refId}:${id}` : `adj:${id}`;
      this.outbox.push({
        id: this.nextIds.outbox++,
        idempotencyKey: key,
        externalId: `itm_${itemId}`,
        deltaUnits: deltaMilli / 1000,
        reason: remoteReason,
        attempts: 0,
        nextAttemptAt: null,
        status: "pending",
      });
    }
    return id;
  }

  async createBill(bill: NewBillPayload): Promise<CreatedBill> {
    if (bill.lines.length === 0) throw new Error("a bill needs at least one line");
    if (bill.payments.length === 0) throw new Error("a bill needs at least one payment");
    const earned = bill.loyaltyEarned ?? 0;
    const redeemed = bill.loyaltyRedeemed ?? 0;
    if (earned < 0 || redeemed < 0) throw new Error("loyalty points must not be negative");
    const loyaltyCustomer =
      bill.customerId !== null && (earned > 0 || redeemed > 0) ? this.customers.get(bill.customerId) : undefined;
    if (loyaltyCustomer && redeemed > (loyaltyCustomer.loyaltyPoints ?? 0)) {
      throw new Error("cannot redeem more loyalty points than the customer has");
    }
    const key = `${bill.fy}${bill.prefix}`;
    const seq = this.invoiceCounters.get(key) ?? 1;
    this.invoiceCounters.set(key, seq + 1);
    const number = formatInvoiceNumber(bill.prefix, seq);
    const id = this.nextIds.bill++;
    const lines: BillLineRow[] = bill.lines.map((l, i) => ({
      id: this.nextIds.line++,
      billId: id,
      lineNo: i + 1,
      itemId: l.itemId,
      nameSnapshot: l.nameSnapshot,
      qtyMilli: l.qtyMilli,
      unitPricePaise: l.unitPricePaise,
      taxRateBp: l.taxRateBp,
      taxPaise: l.taxPaise,
      totalPaise: l.totalPaise,
      discountPaise: l.discountPaise ?? 0,
      hsnCode: l.hsnCode ?? "",
    }));
    // Record what the shop kept: change handed back comes off the cash rows.
    const paid = bill.payments.reduce((s, p) => s + p.amountPaise, 0);
    if (paid < bill.totalPaise) throw new Error("payments do not cover the bill total");
    let change = paid - bill.totalPaise;
    const kept = bill.payments.map((p) => ({ ...p }));
    for (let i = kept.length - 1; i >= 0 && change > 0; i -= 1) {
      if (kept[i]!.mode !== "cash") continue;
      const take = Math.min(change, kept[i]!.amountPaise);
      kept[i]!.amountPaise -= take;
      change -= take;
    }
    if (change > 0) throw new Error("change cannot be more than the cash received");
    const payments: PaymentRow[] = kept.filter((p) => p.amountPaise > 0).map((p) => ({
      id: this.nextIds.payment++,
      billId: id,
      mode: p.mode,
      amountPaise: p.amountPaise,
    }));
    this.bills.set(id, {
      id,
      number,
      fy: bill.fy,
      status: "active",
      customerId: bill.customerId,
      customerName:
        bill.customerId === null ? null : (this.customers.get(bill.customerId)?.name ?? null),
      subtotalPaise: bill.subtotalPaise,
      taxPaise: bill.taxPaise,
      totalPaise: bill.totalPaise,
      discountPaise: bill.discountPaise ?? 0,
      roundOffPaise: bill.roundOffPaise ?? 0,
      notes: bill.notes ?? "",
      createdAt: bill.createdAt,
      voidedAt: null,
      voidReason: null,
      lines,
      payments,
    });
    for (const l of bill.lines) {
      this.recordMovement(l.itemId, -l.qtyMilli, "sale", "bill", String(id));
    }
    if (loyaltyCustomer && bill.customerId !== null) {
      if (earned > 0) await this.updateCustomerLoyalty(bill.customerId, earned, id, `Earned on ${number}`);
      if (redeemed > 0) await this.updateCustomerLoyalty(bill.customerId, -redeemed, id, `Redeemed on ${number}`);
    }
    return { billId: id, number, seq };
  }

  async voidBill(billId: number, reason: string): Promise<void> {
    if (reason.trim() === "") throw new Error("a void reason is required");
    const bill = this.bills.get(billId);
    if (!bill) throw new Error(`no bill with id ${billId}`);
    if (bill.status !== "active") throw new Error(`bill ${billId} is already void`);
    if ([...this.creditNotes.values()].some((n) => n.billId === billId)) {
      throw new Error(`bill ${billId} has credit notes and cannot be voided`);
    }
    bill.status = "void";
    bill.voidedAt = localIsoTimestamp(new Date());
    bill.voidReason = reason;
    for (const l of bill.lines) {
      if (l.itemId !== null) {
        this.recordMovement(l.itemId, l.qtyMilli, "void", "bill", String(billId));
      }
    }
    const net = new Map<number, number>();
    for (const t of this.loyaltyTransactions) {
      if (t.billId === billId) net.set(t.customerId, (net.get(t.customerId) ?? 0) + t.pointsDelta);
    }
    for (const [customerId, points] of net) {
      if (points !== 0) await this.updateCustomerLoyalty(customerId, -points, billId, "Reversed: bill voided");
    }
  }

  async listBills(filter?: BillFilter): Promise<BillSummary[]> {
    let rows = [...this.bills.values()];
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      rows = rows.filter(
        (b) => b.number.toLowerCase().includes(q) || (b.customerName ?? "").toLowerCase().includes(q),
      );
    }
    if (filter?.from) rows = rows.filter((b) => b.createdAt >= filter.from!);
    if (filter?.to) rows = rows.filter((b) => b.createdAt <= filter.to!);
    return rows
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
      .map(({ lines: _l, payments: _p, ...summary }) => summary);
  }

  async getBill(id: number): Promise<BillDetail | null> {
    return this.bills.get(id) ?? null;
  }

  async getBillsReportData(filter?: BillFilter): Promise<ReportBill[]> {
    let rows = [...this.bills.values()];
    if (filter?.from) rows = rows.filter((b) => b.createdAt >= filter.from!);
    if (filter?.to) rows = rows.filter((b) => b.createdAt <= filter.to!);
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    return rows.map((b) => ({
      id: b.id,
      number: b.number,
      status: b.status,
      createdAt: b.createdAt,
      subtotalPaise: b.subtotalPaise,
      taxPaise: b.taxPaise,
      totalPaise: b.totalPaise,
      lines: b.lines.map((l) => ({
        itemId: l.itemId,
        nameSnapshot: l.nameSnapshot,
        qtyMilli: l.qtyMilli,
        totalPaise: l.totalPaise,
        taxPaise: l.taxPaise,
      })),
      payments: b.payments.map((p) => ({
        mode: p.mode,
        amountPaise: p.amountPaise,
      })),
    }));
  }

  async adjustStock(
    itemId: number,
    deltaMilli: number,
    reason: "adjustment" | "purchase" | "import",
  ): Promise<number> {
    if (deltaMilli === 0) throw new Error("an adjustment must change the stock");
    return this.recordMovement(itemId, deltaMilli, reason, "adjustment", null);
  }

  async listMovements(itemId?: number): Promise<StockMovementRecord[]> {
    let rows = [...this.movements];
    if (itemId !== undefined) rows = rows.filter((m) => m.itemId === itemId);
    return rows.sort((a, b) => b.id - a.id).slice(0, 500);
  }

  // --- B2 images -----------------------------------------------------------

  async setItemPhoto(itemId: number, bytes: Uint8Array, imageHash: string): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`no item with id ${itemId}`);
    const kind =
      bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : bytes[1] === 0x50 ? "png" : "webp";
    this.photos.set(itemId, { bytes: new Uint8Array(bytes), imageHash });
    item.photoFile = `${itemId}.${kind}`;
    item.photoPath = item.photoFile;
    item.imageHash = imageHash;
    item.imageUploadedAt = null;
    item.updatedAt = localIsoTimestamp(new Date());
  }

  async clearItemPhoto(itemId: number): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`no item with id ${itemId}`);
    this.photos.delete(itemId);
    item.photoFile = "";
    item.photoPath = item.photoFile;
    item.imageHash = null;
    item.imageUploadedAt = null;
    item.updatedAt = localIsoTimestamp(new Date());
  }

  async readItemPhoto(itemId: number): Promise<{ bytes: Uint8Array; imageHash: string | null } | null> {
    const photo = this.photos.get(itemId);
    if (!photo) return null;
    return { bytes: new Uint8Array(photo.bytes), imageHash: photo.imageHash };
  }

  async listItemImages(itemId: number): Promise<ItemImage[]> {
    return [...this.itemImages.values()]
      .filter((img) => img.itemId === itemId)
      .sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || a.position - b.position || a.id - b.id);
  }

  async addItemImage(
    itemId: number,
    bytes: Uint8Array,
    imageHash: string,
    isMain = false,
  ): Promise<ItemImage> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`no item with id ${itemId}`);
    const existing = await this.listItemImages(itemId);
    const makeMain = isMain || existing.length === 0;

    const kind =
      bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : bytes[1] === 0x50 ? "png" : "webp";
    const id = this.nextIds.itemImage++;
    const fileName = `${itemId}_${id}.${kind}`;
    const now = localIsoTimestamp(new Date());

    if (makeMain) {
      for (const img of existing) {
        if (img.isMain) img.isMain = false;
      }
      item.photoFile = fileName;
      item.photoPath = item.photoFile;
      item.imageHash = imageHash;
      item.imageUploadedAt = null;
      item.updatedAt = now;
      this.photos.set(itemId, { bytes: new Uint8Array(bytes), imageHash });
    }

    const itemImage: ItemImage = {
      id,
      itemId,
      fileName,
      imageHash,
      isMain: makeMain,
      position: existing.length,
      remoteImageId: null,
      imageUploadedAt: null,
      createdAt: now,
    };

    this.itemImages.set(id, itemImage);
    this.imageBytes.set(id, new Uint8Array(bytes));
    return itemImage;
  }

  async deleteItemImage(imageId: number): Promise<void> {
    const img = this.itemImages.get(imageId);
    if (!img) return;
    this.itemImages.delete(imageId);
    this.imageBytes.delete(imageId);

    if (img.isMain) {
      const remaining = await this.listItemImages(img.itemId);
      const item = this.items.get(img.itemId);
      const now = localIsoTimestamp(new Date());
      if (remaining.length > 0 && remaining[0]) {
        const nextMain = remaining[0];
        nextMain.isMain = true;
        if (item) {
          item.photoFile = nextMain.fileName;
          item.photoPath = item.photoFile;
          item.imageHash = nextMain.imageHash;
          item.imageUploadedAt = nextMain.imageUploadedAt;
          item.updatedAt = now;
        }
        const bytes = this.imageBytes.get(nextMain.id);
        if (bytes) {
          this.photos.set(img.itemId, { bytes: new Uint8Array(bytes), imageHash: nextMain.imageHash });
        }
      } else if (item) {
        item.photoFile = "";
        item.photoPath = item.photoFile;
        item.imageHash = null;
        item.imageUploadedAt = null;
        item.updatedAt = now;
        this.photos.delete(img.itemId);
      }
    }
  }

  async setItemImageMain(imageId: number): Promise<void> {
    const img = this.itemImages.get(imageId);
    if (!img) throw new Error(`no image with id ${imageId}`);
    const existing = await this.listItemImages(img.itemId);
    for (const other of existing) {
      other.isMain = other.id === imageId;
    }
    const item = this.items.get(img.itemId);
    const now = localIsoTimestamp(new Date());
    if (item) {
      item.photoFile = img.fileName;
      item.photoPath = item.photoFile;
      item.imageHash = img.imageHash;
      item.imageUploadedAt = img.imageUploadedAt;
      item.updatedAt = now;
    }
    const bytes = this.imageBytes.get(imageId);
    if (bytes) {
      this.photos.set(img.itemId, { bytes: new Uint8Array(bytes), imageHash: img.imageHash });
    }
  }

  async readItemImage(imageId: number): Promise<{ bytes: Uint8Array; imageHash: string } | null> {
    const img = this.itemImages.get(imageId);
    const bytes = this.imageBytes.get(imageId);
    if (!img || !bytes) return null;
    return { bytes: new Uint8Array(bytes), imageHash: img.imageHash };
  }

  async recordImageUploads(
    uploads: readonly { itemId: number; imageHash: string; uploadedAt: string }[],
  ): Promise<void> {
    for (const upload of uploads) {
      const item = this.items.get(upload.itemId);
      // Hash mismatch: the photo was replaced while the upload was in flight.
      if (item && item.imageHash === upload.imageHash) item.imageUploadedAt = upload.uploadedAt;
      for (const img of this.itemImages.values()) {
        if (img.itemId === upload.itemId && img.imageHash === upload.imageHash) {
          img.imageUploadedAt = upload.uploadedAt;
        }
      }
    }
  }

  // --- B1 held bills -------------------------------------------------------

  async listHeldBills(): Promise<HeldBill[]> {
    return [...this.held.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async saveHeldBill(bill: HeldBillInput): Promise<number> {
    if (bill.lines.length === 0) throw new Error("a held bill needs at least one line");
    if (bill.lines.some((l) => l.qtyMilli <= 0)) throw new Error("held line quantities must be positive");
    const lines = bill.lines.map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli }));
    if (bill.id !== undefined) {
      const existing = this.held.get(bill.id);
      if (!existing) throw new Error(`no held bill with id ${bill.id}`);
      Object.assign(existing, { label: bill.label, customerId: bill.customerId, lines });
      return bill.id;
    }
    const id = this.nextIds.held++;
    this.held.set(id, {
      id,
      label: bill.label,
      customerId: bill.customerId,
      lines,
      createdAt: localIsoTimestamp(new Date()),
    });
    return id;
  }

  async takeHeldBill(id: number): Promise<void> {
    if (!this.held.delete(id)) throw new Error(`no held bill with id ${id}`);
  }

  // --- B5 sync -------------------------------------------------------------

  async listOutbox(status?: "pending" | "done"): Promise<OutboxRow[]> {
    return this.outbox
      .filter((r) => status === undefined || r.status === status)
      .map((r) => ({ ...r }));
  }

  async recordOutboxResults(
    results: readonly { idempotencyKey: string; outcome: "done" | "retry"; nextAttemptAt?: string }[],
  ): Promise<void> {
    for (const result of results) {
      const row = this.outbox.find((r) => r.idempotencyKey === result.idempotencyKey);
      if (!row) throw new Error(`no outbox row for key ${result.idempotencyKey}`);
      row.attempts += 1;
      if (result.outcome === "done") {
        row.status = "done";
        row.nextAttemptAt = null;
      } else {
        if (!result.nextAttemptAt) throw new Error("a retry needs a nextAttemptAt");
        row.status = "pending";
        row.nextAttemptAt = result.nextAttemptAt;
      }
    }
  }

  async dropOutbox(keys: readonly string[]): Promise<void> {
    this.outbox = this.outbox.filter((r) => !keys.includes(r.idempotencyKey));
  }

  async getSyncCursor(key: string): Promise<string | null> {
    return this.cursors.get(key) ?? null;
  }

  async setSyncCursor(key: string, value: string): Promise<void> {
    this.cursors.set(key, value);
  }

  async applyStockPull(
    nextCursor: string,
    moves: readonly {
      externalId: string;
      deltaUnits: number;
      reason: "online_order" | "order_cancel" | "adjustment";
      createdAt: string;
    }[],
  ): Promise<{ externalId: string; itemId: number | null; deltaMilli: number }[]> {
    this.cursors.set("stock", nextCursor);
    const applied: { externalId: string; itemId: number | null; deltaMilli: number }[] = [];
    for (const move of moves) {
      if (move.deltaUnits === 0) continue;
      const item = [...this.items.values()].find(
        (i) => i.remoteProductId === move.externalId || `itm_${i.id}` === move.externalId,
      );
      const deltaMilli = move.deltaUnits * 1000;
      if (item) this.recordMovement(item.id, deltaMilli, move.reason, "sync", move.externalId);
      applied.push({ externalId: move.externalId, itemId: item?.id ?? null, deltaMilli });
    }
    return applied;
  }

  async recordRemoteCatalog(items: readonly RemoteItemLink[]): Promise<number> {
    let linked = 0;
    for (const link of items) {
      const item = [...this.items.values()].find(
        (i) => i.remoteProductId === link.externalId || `itm_${i.id}` === link.externalId,
      );
      if (!item) continue;
      item.remoteHash = link.remoteHash;
      linked += 1;
    }
    return linked;
  }

  /**
   * Local wins: the item keeps its local values and the catalog push (price +
   * stock) will carry them to the marketplace, so the publish hash is cleared
   * to force a re-send. Pull-to-local writes the remote values instead.
   */
  async applyReconcileFixes(fixes: readonly ReconcileFix[]): Promise<void> {
    const now = localIsoTimestamp(new Date());
    for (const fix of fixes) {
      if (fix.kind === "missing_remote" && fix.pullToLocal) {
        throw new Error("a missing marketplace item can only be pushed");
      }
      const item = this.items.get(fix.itemId);
      if (!item) throw new Error(`no item with id ${fix.itemId}`);
      if (fix.pullToLocal) {
        if (fix.kind === "price" && fix.pricePaise !== undefined) item.pricePaise = fix.pricePaise;
        if (fix.kind === "stock" && fix.stockUnits !== undefined) {
          this.recordMovement(item.id, fix.stockUnits * 1000 - item.stockMilli, "adjustment", null, null);
        }
        if (fix.kind === "remote_inactive") item.isActive = false;
      } else if (fix.kind === "missing_remote") {
        item.remoteProductId = null;
        item.remoteVariantId = null;
        item.contentHash = null;
        item.publishState = "local_only";
      } else {
        item.contentHash = null;
      }
      item.updatedAt = now;
    }
  }

  // --- generic settings ----------------------------------------------------

  async getAppSetting(key: string): Promise<string | null> {
    return this.appSettings.get(key) ?? null;
  }

  async setAppSetting(key: string, value: string | null): Promise<void> {
    if (value === null) this.appSettings.delete(key);
    else this.appSettings.set(key, value);
  }

  // --- Phase 2: Credit Notes ------------------------------------------------

  async createCreditNote(payload: NewCreditNotePayload): Promise<{ creditNoteId: number; number: string }> {
    if (payload.lines.length === 0) throw new Error("a credit note needs at least one line");
    if (!payload.reason.trim()) throw new Error("credit note reason is required");
    const bill = this.bills.get(payload.billId);
    if (!bill) throw new Error(`no bill with id ${payload.billId}`);
    if (bill.status !== "active") throw new Error(`bill ${payload.billId} is void; it cannot be returned against`);
    const requested = new Map<number, number>();
    for (const l of payload.lines) {
      if (l.qtyMilli <= 0) throw new Error("returned quantity must be positive");
      if (l.itemId === null) throw new Error("credit note lines must reference an item");
      requested.set(l.itemId, (requested.get(l.itemId) ?? 0) + l.qtyMilli);
    }
    for (const [itemId, qty] of requested) {
      const sold = bill.lines.filter((l) => l.itemId === itemId).reduce((s, l) => s + l.qtyMilli, 0);
      if (sold === 0) throw new Error(`item ${itemId} is not on bill ${payload.billId}`);
      const returned = [...this.creditNotes.values()]
        .filter((n) => n.billId === payload.billId)
        .flatMap((n) => n.lines)
        .filter((l) => l.itemId === itemId)
        .reduce((s, l) => s + l.qtyMilli, 0);
      if (returned + qty > sold) throw new Error(`cannot return more than was sold for item ${itemId}`);
    }

    const fy = bill.fy;
    const key = `${fy}CN-`;
    const seq = this.invoiceCounters.get(key) ?? 1;
    this.invoiceCounters.set(key, seq + 1);
    const number = `CN-${fy}-${String(seq).padStart(4, "0")}`;

    let subtotalPaise = 0;
    let taxPaise = 0;
    let totalPaise = 0;
    for (const line of payload.lines) {
      subtotalPaise += line.totalPaise - line.taxPaise;
      taxPaise += line.taxPaise;
      totalPaise += line.totalPaise;
    }

    const id = this.nextIds.creditNote++;
    const lines: CreditNoteLine[] = payload.lines.map((l) => {
      const lineId = this.nextIds.creditNoteLine++;
      if (l.itemId !== null) {
        const item = this.items.get(l.itemId);
        if (item) {
          this.recordMovement(l.itemId, l.qtyMilli, "return", "credit_note", String(id));
        }
      }
      return {
        id: lineId,
        creditNoteId: id,
        itemId: l.itemId,
        nameSnapshot: l.nameSnapshot,
        qtyMilli: l.qtyMilli,
        unitPricePaise: l.unitPricePaise,
        taxRateBp: l.taxRateBp,
        taxPaise: l.taxPaise,
        totalPaise: l.totalPaise,
        hsnCode: l.hsnCode ?? "",
      };
    });

    const note: CreditNote = {
      id,
      billId: payload.billId,
      number,
      fy,
      reason: payload.reason.trim(),
      subtotalPaise,
      taxPaise,
      totalPaise,
      createdAt: payload.createdAt || localIsoTimestamp(new Date()),
      lines,
    };
    this.creditNotes.set(id, note);
    return { creditNoteId: id, number };
  }

  async listCreditNotes(billId?: number): Promise<CreditNote[]> {
    const list = [...this.creditNotes.values()];
    const filtered = billId !== undefined ? list.filter((n) => n.billId === billId) : list;
    return filtered.sort((a, b) => b.id - a.id);
  }

  async getCreditNote(id: number): Promise<CreditNote | null> {
    return this.creditNotes.get(id) ?? null;
  }

  // --- Phase 2: Suppliers & Purchases ---------------------------------------

  async listSuppliers(search?: string): Promise<Supplier[]> {
    let list = [...this.suppliers.values()];
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.phone.toLowerCase().includes(q) ||
          s.gstin.toLowerCase().includes(q),
      );
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  async upsertSupplier(input: SupplierInput): Promise<number> {
    if (!input.name.trim()) throw new Error("supplier name is required");
    if (input.id !== undefined) {
      const existing = this.suppliers.get(input.id);
      if (!existing) throw new Error(`no supplier with id ${input.id}`);
      existing.name = input.name.trim();
      existing.phone = input.phone?.trim() ?? existing.phone;
      existing.gstin = input.gstin?.trim() ?? existing.gstin;
      existing.address = input.address?.trim() ?? existing.address;
      return existing.id;
    }
    const id = this.nextIds.supplier++;
    const s: Supplier = {
      id,
      name: input.name.trim(),
      phone: input.phone?.trim() ?? "",
      gstin: input.gstin?.trim() ?? "",
      address: input.address?.trim() ?? "",
      createdAt: localIsoTimestamp(new Date()),
    };
    this.suppliers.set(id, s);
    return id;
  }

  async deleteSupplier(id: number): Promise<boolean> {
    for (const p of this.purchases.values()) {
      if (p.supplierId === id) throw new Error("cannot delete supplier with recorded purchases");
    }
    return this.suppliers.delete(id);
  }

  async createPurchase(payload: NewPurchasePayload): Promise<{ purchaseId: number }> {
    if (payload.lines.length === 0) throw new Error("a purchase invoice needs at least one line");
    if (!payload.invoiceNo.trim()) throw new Error("purchase invoice number is required");
    const supplier = this.suppliers.get(payload.supplierId);
    if (!supplier) throw new Error(`no supplier with id ${payload.supplierId}`);

    let subtotal = 0;
    let tax = 0;
    let total = 0;
    const id = this.nextIds.purchase++;

    const lines: PurchaseLine[] = payload.lines.map((l) => {
      if (l.qtyMilli <= 0) throw new Error("quantity must be positive");
      const lineSubtotal = Math.floor((l.qtyMilli * l.unitCostPaise) / 1000);
      const lineTax = Math.floor((lineSubtotal * l.taxRateBp + 5000) / 10000);
      const lineTotal = lineSubtotal + lineTax;
      subtotal += lineSubtotal;
      tax += lineTax;
      total += lineTotal;

      if (l.itemId !== null) {
        const item = this.items.get(l.itemId);
        if (item) {
          item.costPricePaise = l.unitCostPaise;
          this.recordMovement(l.itemId, l.qtyMilli, "purchase", "purchase", String(id));
        }
      }

      return {
        id: this.nextIds.purchaseLine++,
        purchaseId: id,
        itemId: l.itemId,
        nameSnapshot: l.nameSnapshot,
        qtyMilli: l.qtyMilli,
        unitCostPaise: l.unitCostPaise,
        taxRateBp: l.taxRateBp,
        taxPaise: lineTax,
        totalPaise: lineTotal,
      };
    });

    const p: Purchase = {
      id,
      supplierId: payload.supplierId,
      supplierName: supplier.name,
      invoiceNo: payload.invoiceNo.trim(),
      invoiceDate: payload.invoiceDate.trim(),
      subtotalPaise: subtotal,
      taxPaise: tax,
      totalPaise: total,
      status: payload.status ?? "received",
      createdAt: payload.createdAt || localIsoTimestamp(new Date()),
      lines,
    };
    this.purchases.set(id, p);
    return { purchaseId: id };
  }

  async listPurchases(supplierId?: number): Promise<Purchase[]> {
    let list = [...this.purchases.values()];
    if (supplierId !== undefined) {
      list = list.filter((p) => p.supplierId === supplierId);
    }
    return list
      .map((p) => ({
        ...p,
        supplierName: this.suppliers.get(p.supplierId)?.name,
      }))
      .sort((a, b) => b.id - a.id);
  }

  async getPurchase(id: number): Promise<Purchase | null> {
    const p = this.purchases.get(id);
    if (!p) return null;
    return {
      ...p,
      supplierName: this.suppliers.get(p.supplierId)?.name,
    };
  }

  // --- Phase 2: Users & Roles & Audit ---------------------------------------

  async listUsers(): Promise<User[]> {
    return [...this.users.values()].sort((a, b) => a.id - b.id);
  }

  async upsertUser(input: UserInput): Promise<number> {
    if (!input.name.trim()) throw new Error("user name is required");
    if (input.role !== "owner" && input.role !== "cashier") throw new Error("role must be 'owner' or 'cashier'");
    const pin = input.pin.trim();
    if ((input.id === undefined || pin !== "") && !/^\d{4,6}$/.test(pin)) {
      throw new Error("PIN must be 4 to 6 digits");
    }
    let saved: User;
    let previous: User | undefined;
    if (input.id !== undefined) {
      const existing = this.users.get(input.id);
      if (!existing) throw new Error(`no user with id ${input.id}`);
      previous = { ...existing };
      existing.name = input.name.trim();
      existing.role = input.role;
      if (input.isActive !== undefined) existing.isActive = input.isActive;
      saved = existing;
    } else {
      saved = {
        id: this.nextIds.user,
        name: input.name.trim(),
        role: input.role,
        hasPin: false,
        isActive: input.isActive ?? true,
        createdAt: localIsoTimestamp(new Date()),
      };
      this.users.set(saved.id, saved);
    }
    const previousPin = this.pins.get(saved.id);
    if (pin !== "") {
      this.pins.set(saved.id, pin);
      saved.hasPin = true;
    }
    // Same rule as the desktop shell: once PINs exist, an active owner must remain.
    const anyPin = this.pins.size > 0;
    const owner = [...this.users.values()].some((u) => u.isActive && u.role === "owner" && this.pins.has(u.id));
    if (anyPin && !owner) {
      // roll back
      if (previous) Object.assign(saved, previous);
      else this.users.delete(saved.id);
      if (previousPin === undefined) this.pins.delete(saved.id);
      else this.pins.set(saved.id, previousPin);
      throw new Error("at least one active owner with a PIN is required");
    }
    if (input.id === undefined) this.nextIds.user += 1;
    return saved.id;
  }

  async verifyPin(pin: string, requiredRole?: UserRole): Promise<User | null> {
    const trimmed = pin.trim();
    if (!trimmed) return null;
    for (const u of this.users.values()) {
      if (u.isActive && this.pins.get(u.id) === trimmed) {
        if (!requiredRole || u.role === requiredRole) {
          return { ...u };
        }
      }
    }
    return null;
  }

  async logout(): Promise<void> {
    setSessionToken(null);
  }

  async recordAuditLog(input: AuditLogInput): Promise<number> {
    if (!input.action.trim()) throw new Error("audit action is required");
    const id = this.nextIds.auditLog++;
    const user = input.userId ? this.users.get(input.userId) : null;
    const log: AuditLog = {
      id,
      userId: input.userId ?? null,
      userName: user?.name,
      action: input.action.trim(),
      details: input.details?.trim() ?? "",
      createdAt: input.createdAt || localIsoTimestamp(new Date()),
    };
    this.auditLogs.push(log);
    return id;
  }

  async listAuditLogs(limit = 100): Promise<AuditLog[]> {
    return [...this.auditLogs]
      .map((l) => ({
        ...l,
        userName: l.userId ? this.users.get(l.userId)?.name : undefined,
      }))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  // --- Phase 2: Stock Audit -------------------------------------------------

  async applyStockAudit(discrepancies: StockDiscrepancyInput[]): Promise<number> {
    let adjusted = 0;
    for (const disc of discrepancies) {
      const item = this.items.get(disc.itemId);
      if (!item) throw new Error(`no item with id ${disc.itemId}`);
      const delta = disc.physicalCountMilli - item.stockMilli;
      if (delta !== 0) {
        this.recordMovement(disc.itemId, delta, "adjustment", "stock_audit", null);
        adjusted++;
      }
    }
    return adjusted;
  }

  // --- Phase 3: Batches & Expiry --------------------------------------------

  async upsertBatch(input: BatchInput): Promise<number> {
    if (!input.batchNo.trim()) throw new Error("batch number is required");
    if (!input.expiryDate.trim()) throw new Error("expiry date is required");

    if (input.id) {
      const existing = this.batches.get(input.id);
      if (!existing) throw new Error(`no batch with id ${input.id}`);
      const updated: ItemBatch = {
        ...existing,
        batchNo: input.batchNo.trim(),
        mfgDate: input.mfgDate ? input.mfgDate.trim() : null,
        expiryDate: input.expiryDate.trim(),
        costPricePaise: input.costPricePaise,
        mrpPaise: input.mrpPaise,
        stockMilli: input.stockMilli,
      };
      this.batches.set(input.id, updated);
      return input.id;
    }

    const id = this.nextIds.batch++;
    const batch: ItemBatch = {
      id,
      itemId: input.itemId,
      batchNo: input.batchNo.trim(),
      mfgDate: input.mfgDate ? input.mfgDate.trim() : null,
      expiryDate: input.expiryDate.trim(),
      costPricePaise: input.costPricePaise,
      mrpPaise: input.mrpPaise,
      stockMilli: input.stockMilli,
      createdAt: input.createdAt || localIsoTimestamp(new Date()),
    };
    this.batches.set(id, batch);
    return id;
  }

  async listBatchesForItem(itemId: number): Promise<ItemBatch[]> {
    const list = Array.from(this.batches.values()).filter((b) => b.itemId === itemId);
    return sortBatchesFifo(list);
  }

  async listExpiringBatches(daysThreshold: number): Promise<ItemBatch[]> {
    const now = new Date();
    const cutoff = new Date(now.getTime() + daysThreshold * 24 * 60 * 60 * 1000);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const list = Array.from(this.batches.values()).filter(
      (b) => b.stockMilli > 0 && b.expiryDate.slice(0, 10) <= cutoffIso,
    );
    return sortBatchesFifo(list);
  }

  // --- Phase 3: Customer Loyalty Points -------------------------------------

  async updateCustomerLoyalty(
    customerId: number,
    pointsDelta: number,
    billId?: number | null,
    reason?: string,
  ): Promise<number> {
    const customer = this.customers.get(customerId);
    if (!customer) throw new Error(`no customer with id ${customerId}`);

    const newPoints = Math.max(0, (customer.loyaltyPoints ?? 0) + pointsDelta);
    customer.loyaltyPoints = newPoints;

    const id = this.nextIds.loyaltyTx++;
    this.loyaltyTransactions.push({
      id,
      customerId,
      billId: billId ?? null,
      pointsDelta,
      reason: reason ?? "",
      createdAt: localIsoTimestamp(new Date()),
    });
    return newPoints;
  }

  async getCustomerLoyaltyBalance(customerId: number): Promise<number> {
    const customer = this.customers.get(customerId);
    return customer?.loyaltyPoints ?? 0;
  }

  async listLoyaltyTransactions(customerId: number): Promise<LoyaltyTransaction[]> {
    return this.loyaltyTransactions
      .filter((t) => t.customerId === customerId)
      .sort((a, b) => b.id - a.id);
  }

  // --- Phase 3: Multi-Barcodes ----------------------------------------------

  async upsertItemBarcode(
    itemId: number,
    barcode: string,
    packQtyMilli = 1000,
    label = "",
  ): Promise<number> {
    const trimmed = barcode.trim();
    if (!trimmed) throw new Error("barcode cannot be empty");

    for (const b of this.itemBarcodes.values()) {
      if (b.barcode === trimmed) {
        b.itemId = itemId;
        b.packQtyMilli = packQtyMilli;
        b.label = label.trim();
        return b.id;
      }
    }

    const id = this.nextIds.itemBarcode++;
    const row: ItemBarcode = {
      id,
      itemId,
      barcode: trimmed,
      packQtyMilli,
      label: label.trim(),
    };
    this.itemBarcodes.set(id, row);
    return id;
  }

  async listItemBarcodes(itemId: number): Promise<ItemBarcode[]> {
    return Array.from(this.itemBarcodes.values())
      .filter((b) => b.itemId === itemId)
      .sort((a, b) => a.id - b.id);
  }

  async deleteItemBarcode(barcodeId: number): Promise<void> {
    this.itemBarcodes.delete(barcodeId);
  }

  async lookupItemByAnyBarcode(barcode: string): Promise<BarcodeLookupResult | null> {
    const trimmed = barcode.trim();
    if (!trimmed) return null;

    // 1. Check secondary barcodes
    for (const b of this.itemBarcodes.values()) {
      if (b.barcode === trimmed) {
        const item = this.items.get(b.itemId);
        if (item && item.isActive) {
          return {
            itemId: item.id,
            itemName: item.name,
            barcode: b.barcode,
            packQtyMilli: b.packQtyMilli,
            pricePaise: item.pricePaise,
          };
        }
      }
    }

    // 2. Check primary barcode
    for (const item of this.items.values()) {
      if (item.barcode === trimmed && item.isActive) {
        return {
          itemId: item.id,
          itemName: item.name,
          barcode: item.barcode,
          packQtyMilli: 1000,
          pricePaise: item.pricePaise,
        };
      }
    }

    return null;
  }

  // --- Phase 3: Day-End Closing & Z-Report -----------------------------------

  async createDayEndClosure(input: DayEndClosureInput): Promise<number> {
    const id = this.nextIds.dayEndClosure++;
    const user = input.userId ? this.users.get(input.userId) : null;
    const closure: DayEndClosure = {
      id,
      closureDate: input.closureDate.trim(),
      userId: input.userId ?? null,
      userName: user?.name,
      openingCashPaise: input.openingCashPaise,
      cashSalesPaise: input.cashSalesPaise,
      creditReceivedPaise: input.creditReceivedPaise,
      cashRefundsPaise: input.cashRefundsPaise,
      expectedCashPaise: input.expectedCashPaise,
      actualCashPaise: input.actualCashPaise,
      variancePaise: input.variancePaise,
      totalBillsCount: input.totalBillsCount,
      totalSalesPaise: input.totalSalesPaise,
      notes: input.notes?.trim() ?? "",
      createdAt: input.createdAt || localIsoTimestamp(new Date()),
    };
    this.dayEndClosures.set(id, closure);
    return id;
  }

  async listDayEndClosures(fromDate?: string, toDate?: string): Promise<DayEndClosure[]> {
    let list = Array.from(this.dayEndClosures.values());
    if (fromDate) {
      list = list.filter((c) => c.closureDate >= fromDate);
    }
    if (toDate) {
      list = list.filter((c) => c.closureDate <= toDate);
    }
    return list.sort((a, b) => b.id - a.id);
  }

  async getDayEndExpectedCash(datePrefix: string): Promise<DayEndExpectedCash> {
    const prefix = datePrefix.trim();

    let cashSalesPaise = 0;
    let totalBillsCount = 0;
    let totalSalesPaise = 0;

    for (const b of this.bills.values()) {
      if (b.status === "active" && b.createdAt.startsWith(prefix)) {
        totalBillsCount++;
        totalSalesPaise += b.totalPaise;
        for (const p of b.payments) {
          if (p.mode === "cash") {
            cashSalesPaise += p.amountPaise;
          }
        }
      }
    }

    let creditReceivedPaise = 0;
    for (const cp of this.customerPayments) {
      if (cp.mode === "cash" && cp.createdAt.startsWith(prefix)) {
        creditReceivedPaise += cp.amountPaise;
      }
    }

    const refunds = creditNoteCashRefunds(
      [...this.bills.values()],
      [...this.creditNotes.values()],
    );
    let cashRefundsPaise = 0;
    for (const cn of this.creditNotes.values()) {
      if (cn.createdAt.startsWith(prefix)) cashRefundsPaise += refunds.get(cn.id) ?? 0;
    }

    return {
      cashSalesPaise,
      creditReceivedPaise,
      cashRefundsPaise,
      totalBillsCount,
      totalSalesPaise,
    };
  }
}
