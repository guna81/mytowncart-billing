// SPDX-License-Identifier: Apache-2.0
/**
 * In-memory adapter implementing the same repository semantics as the Rust
 * shell (invoice counters per (fy, prefix), compensating void movements,
 * cached stock = ledger sum, per-row CSV import isolation). Used by Vitest
 * and by the web UI when it is NOT running inside Tauri (plain-browser dev
 * and Playwright).
 */

import { formatInvoiceNumber, localIsoTimestamp } from "@mytowncart-billing/core";
import type {
  BillingRepository,
  BillFilter,
  CreatedBill,
  ItemFilter,
  NewBillPayload,
} from "./repository";
import type {
  BillDetail,
  BillLineRow,
  BillSummary,
  Category,
  Customer,
  HeldBill,
  HeldBillInput,
  ImportRowOutcome,
  Item,
  ItemInput,
  OutboxRow,
  PaymentRow,
  PublishOutcome,
  ReconcileFix,
  RemoteItemLink,
  RemoteOrderRecord,
  ShopProfile,
  StockMovementRecord,
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
  private bills = new Map<number, BillDetail>();
  private movements: StockMovementRecord[] = [];
  private invoiceCounters = new Map<string, number>(); // `${fy}${prefix}` -> next seq
  private nextIds = {
    category: 1, item: 1, customer: 1, bill: 1, line: 1, payment: 1, movement: 1, held: 1,
    outbox: 1,
  };
  private photos = new Map<number, MemoryPhoto>();
  private held = new Map<number, HeldBill>();
  private outbox: OutboxRow[] = [];
  private cursors = new Map<string, string>();
  private remoteOrders = new Map<string, RemoteOrderRecord>();
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
        (i) => i.name.toLowerCase().includes(q) || i.barcode.toLowerCase().includes(q),
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

  async upsertCustomer(input: { id?: number; name: string; phone: string }): Promise<number> {
    if (input.name.trim() === "") throw new Error("customer name is required");
    const now = localIsoTimestamp(new Date());
    if (input.id !== undefined) {
      const existing = this.customers.get(input.id);
      if (!existing) throw new Error(`no customer with id ${input.id}`);
      existing.name = input.name;
      existing.phone = input.phone;
      existing.updatedAt = now;
      return input.id;
    }
    const id = this.nextIds.customer++;
    this.customers.set(id, { id, name: input.name, phone: input.phone, createdAt: now, updatedAt: now });
    return id;
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
    }));
    const payments: PaymentRow[] = bill.payments.map((p) => ({
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
      createdAt: bill.createdAt,
      voidedAt: null,
      voidReason: null,
      lines,
      payments,
    });
    for (const l of bill.lines) {
      this.recordMovement(l.itemId, -l.qtyMilli, "sale", "bill", String(id));
    }
    return { billId: id, number, seq };
  }

  async voidBill(billId: number, reason: string): Promise<void> {
    if (reason.trim() === "") throw new Error("a void reason is required");
    const bill = this.bills.get(billId);
    if (!bill) throw new Error(`no bill with id ${billId}`);
    if (bill.status !== "active") throw new Error(`bill ${billId} is already void`);
    bill.status = "void";
    bill.voidedAt = localIsoTimestamp(new Date());
    bill.voidReason = reason;
    for (const l of bill.lines) {
      if (l.itemId !== null) {
        this.recordMovement(l.itemId, l.qtyMilli, "void", "bill", String(billId));
      }
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
    item.imageHash = imageHash;
    item.imageUploadedAt = null;
    item.updatedAt = localIsoTimestamp(new Date());
  }

  async clearItemPhoto(itemId: number): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`no item with id ${itemId}`);
    this.photos.delete(itemId);
    item.photoFile = "";
    item.imageHash = null;
    item.imageUploadedAt = null;
    item.updatedAt = localIsoTimestamp(new Date());
  }

  async readItemPhoto(itemId: number): Promise<{ bytes: Uint8Array; imageHash: string | null } | null> {
    const photo = this.photos.get(itemId);
    if (!photo) return null;
    return { bytes: new Uint8Array(photo.bytes), imageHash: photo.imageHash };
  }

  async recordImageUploads(
    uploads: readonly { itemId: number; imageHash: string; uploadedAt: string }[],
  ): Promise<void> {
    for (const upload of uploads) {
      const item = this.items.get(upload.itemId);
      // Hash mismatch: the photo was replaced while the upload was in flight.
      if (item && item.imageHash === upload.imageHash) item.imageUploadedAt = upload.uploadedAt;
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
      const item = [...this.items.values()].find((i) => i.remoteProductId === move.externalId);
      const deltaMilli = move.deltaUnits * 1000;
      if (item) this.recordMovement(item.id, deltaMilli, move.reason, "sync", move.externalId);
      applied.push({ externalId: move.externalId, itemId: item?.id ?? null, deltaMilli });
    }
    return applied;
  }

  async recordRemoteCatalog(items: readonly RemoteItemLink[]): Promise<number> {
    let linked = 0;
    for (const link of items) {
      const item = [...this.items.values()].find((i) => i.remoteProductId === link.externalId);
      if (!item) continue;
      item.remoteHash = link.remoteHash;
      linked += 1;
    }
    return linked;
  }

  async listRemoteOrders(): Promise<RemoteOrderRecord[]> {
    return [...this.remoteOrders.values()].sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  }

  async recordRemoteOrders(orders: readonly RemoteOrderRecord[]): Promise<number> {
    for (const order of orders) this.remoteOrders.set(order.id, { ...order });
    return orders.length;
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
}
