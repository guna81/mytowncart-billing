// SPDX-License-Identifier: Apache-2.0
/**
 * Tauri adapter: bridges the repository interface to the Rust shell's typed
 * commands via `@tauri-apps/api` invoke. Reads use the generic parameterized
 * `query_rows` command; every multi-table write is a dedicated command.
 */

import { isUnitKind, localIsoTimestamp, type ReportBill, type UnitKind } from "@mytowncart-billing/core";
import { SESSION_GATED_COMMANDS, getSessionToken, setSessionToken } from "./session";
import { buildCustomerLedger, type LedgerBill } from "./ledger";
import type { BillingRepository, BillFilter, CreatedBill, ItemFilter, NewBillPayload } from "./repository";
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

type Row = Record<string, unknown>;

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

async function defaultTauriInvoker(): Promise<InvokeFn> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke as InvokeFn;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}
function optNum(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}
function bool(v: unknown): boolean {
  return v === 1 || v === true;
}

function parseJsonAttributes(v: unknown): Record<string, string> {
  if (typeof v !== "string" || !v.trim()) return {};
  try {
    const parsed = JSON.parse(v);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: Record<string, string> = {};
      for (const [k, val] of Object.entries(parsed)) {
        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
          result[k] = String(val);
        }
      }
      return result;
    }
  } catch {
    // Ignore invalid JSON
  }
  return {};
}

function rowToItem(r: Row): Item {
  return {
    id: num(r.id),
    name: str(r.name),
    barcode: str(r.barcode),
    categoryId: optNum(r.category_id),
    categoryName: r.category_name === null || r.category_name === undefined ? null : str(r.category_name),
    unitKind: isUnitKind(str(r.unit_kind)) ? (str(r.unit_kind) as UnitKind) : "count",
    pricePaise: num(r.price_paise),
    mrpPaise: num(r.mrp_paise),
    taxRateBp: num(r.tax_rate_bp),
    stockMilli: num(r.stock_milli),
    isActive: bool(r.is_active),
    photoPath: str(r.photo_path),
    publishState: str(r.publish_state),
    remoteProductId: r.remote_product_id == null ? null : str(r.remote_product_id),
    remoteVariantId: r.remote_variant_id == null ? null : str(r.remote_variant_id),
    contentHash: r.content_hash == null ? null : str(r.content_hash),
    photoFile: str(r.photo_path),
    imageHash: r.image_hash == null ? null : str(r.image_hash),
    imageUploadedAt: r.image_uploaded_at == null ? null : str(r.image_uploaded_at),
    remoteHash: r.remote_hash == null ? null : str(r.remote_hash),
    hsnCode: str(r.hsn_code ?? ""),
    costPricePaise: num(r.cost_price_paise ?? 0),
    description: str(r.description ?? ""),
    brand: str(r.brand ?? ""),
    customAttributes: parseJsonAttributes(r.custom_attributes),
    variantGroup: str(r.variant_group ?? ""),
    variantOptions: parseJsonAttributes(r.variant_options),
    updatedAt: str(r.updated_at),
  };
}

function rowToBillSummary(r: Row): BillSummary {
  return {
    id: num(r.id),
    number: str(r.number),
    fy: str(r.fy),
    status: str(r.status) === "void" ? "void" : "active",
    customerId: optNum(r.customer_id),
    customerName: r.customer_name == null ? null : str(r.customer_name),
    subtotalPaise: num(r.subtotal_paise),
    taxPaise: num(r.tax_paise),
    totalPaise: num(r.total_paise),
    discountPaise: num(r.discount_paise ?? 0),
    roundOffPaise: num(r.round_off_paise ?? 0),
    notes: str(r.notes ?? ""),
    createdAt: str(r.created_at),
    voidedAt: r.voided_at == null ? null : str(r.voided_at),
    voidReason: r.void_reason == null ? null : str(r.void_reason),
  };
}

const ITEM_SELECT =
  "SELECT i.id, i.name, i.barcode, i.category_id, c.name AS category_name, i.unit_kind, " +
  "i.price_paise, i.mrp_paise, i.tax_rate_bp, i.stock_milli, i.is_active, i.photo_path, " +
  "i.publish_state, i.remote_product_id, i.remote_variant_id, i.content_hash, " +
  "i.photo_path, i.image_hash, i.image_uploaded_at, i.remote_hash, i.hsn_code, i.cost_price_paise, " +
  "i.description, i.brand, i.custom_attributes, i.variant_group, i.variant_options, i.updated_at " +
  "FROM items i LEFT JOIN categories c ON c.id = i.category_id";

const BILL_SELECT =
  "SELECT b.id, b.number, b.fy, b.status, b.customer_id, cu.name AS customer_name, " +
  "b.subtotal_paise, b.tax_paise, b.total_paise, b.discount_paise, b.round_off_paise, b.notes, " +
  "b.created_at, b.voided_at, b.void_reason " +
  "FROM bills b LEFT JOIN customers cu ON cu.id = b.customer_id";

function itemToPayload(input: ItemInput, now: string): Record<string, unknown> {
  return {
    id: input.id ?? null,
    name: input.name,
    barcode: input.barcode,
    categoryId: input.categoryId,
    unitKind: input.unitKind,
    pricePaise: input.pricePaise,
    mrpPaise: input.mrpPaise,
    taxRateBp: input.taxRateBp,
    openingStockMilli: input.openingStockMilli,
    isActive: input.isActive,
    hsnCode: input.hsnCode ?? "",
    costPricePaise: input.costPricePaise ?? 0,
    description: input.description ?? "",
    brand: input.brand ?? "",
    customAttributes: JSON.stringify(input.customAttributes ?? {}),
    variantGroup: input.variantGroup ?? "",
    variantOptions: JSON.stringify(input.variantOptions ?? {}),
    now,
  };
}

export class TauriRepository implements BillingRepository {
  readonly kind: "tauri" | "http" = "tauri";
  protected readonly customInvoker?: InvokeFn;

  constructor(customInvoker?: InvokeFn) {
    this.customInvoker = customInvoker;
  }

  protected async getInvoke(): Promise<InvokeFn> {
    const base = this.customInvoker ?? (await defaultTauriInvoker());
    // Sensitive commands carry the login session so Rust can check the user's role.
    return async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      if (SESSION_GATED_COMMANDS.has(cmd)) {
        return base<T>(cmd, { ...(args ?? {}), session: getSessionToken() });
      }
      return base<T>(cmd, args);
    };
  }

  protected async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const invoke = await this.getInvoke();
    return invoke<Row[]>("query_rows", { sql, params });
  }

  async getShopProfile(): Promise<ShopProfile | null> {
    const rows = await this.query("SELECT * FROM shop_profile WHERE id = 1");
    const r = rows[0];
    if (!r) return null;
    return {
      name: str(r.name),
      gstEnabled: bool(r.gst_enabled),
      pricesIncludeTax: bool(r.prices_include_tax),
      invoicePrefix: str(r.invoice_prefix),
      address: str(r.address),
      phone: str(r.phone),
      gstin: str(r.gstin),
      receiptFooter: str(r.receipt_footer),
      lowStockThresholdMilli: num(r.low_stock_threshold_milli),
      updatedAt: str(r.updated_at),
    };
  }

  async saveShopProfile(
    profile: Omit<ShopProfile, "updatedAt"> & { updatedAt?: string },
  ): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("save_shop_profile", {
      profile: { ...profile, updatedAt: profile.updatedAt ?? new Date().toISOString() },
    });
  }

  async listCategories(): Promise<Category[]> {
    const rows = await this.query("SELECT id, name, marketplace_category_id FROM categories ORDER BY name");
    return rows.map((r) => ({
      id: num(r.id),
      name: str(r.name),
      marketplaceCategoryId:
      r.marketplace_category_id == null ? null : str(r.marketplace_category_id),
    }));
  }

  async upsertCategory(input: { id?: number; name: string }): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("upsert_category", {
      category: { id: input.id ?? null, name: input.name },
    });
  }

  async setCategoryMarketplaceId(
    categoryId: number,
    marketplaceCategoryId: string | null,
  ): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke<void>("record_publish", {
      outcomes: [],
      categoryMappings: [{ categoryId, marketplaceCategoryId }],
    });
  }

  async recordPublish(
    outcomes: readonly PublishOutcome[],
    marketplaceCategoryIds: ReadonlyMap<number, string>,
  ): Promise<void> {
    const invoke = await this.getInvoke();
    const updatedAt = localIsoTimestamp(new Date());
    await invoke<void>("record_publish", {
      outcomes: outcomes.map((o) => ({
        itemId: o.itemId,
        state: o.state,
        updatedAt,
        remoteProductId: o.remoteProductId,
        remoteVariantId: o.remoteVariantId,
        contentHash: o.contentHash,
      })),
      categoryMappings: [...marketplaceCategoryIds].map(([categoryId, marketplaceCategoryId]) => ({
        categoryId,
        marketplaceCategoryId,
      })),
    });
  }

  async listItems(filter?: ItemFilter): Promise<Item[]> {
    let sql = ITEM_SELECT;
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter?.activeOnly !== false) where.push("i.is_active = 1");
    if (filter?.search) {
      where.push(
        `(i.name LIKE ?${params.length + 1} OR i.barcode LIKE ?${params.length + 2} OR i.brand LIKE ?${params.length + 3} OR i.description LIKE ?${params.length + 4})`,
      );
      params.push(`%${filter.search}%`, `%${filter.search}%`, `%${filter.search}%`, `%${filter.search}%`);
    }
    if (where.length > 0) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY i.name";
    return (await this.query(sql, params)).map(rowToItem);
  }

  async getItem(id: number): Promise<Item | null> {
    const rows = await this.query(`${ITEM_SELECT} WHERE i.id = ?1`, [id]);
    return rows[0] ? rowToItem(rows[0]) : null;
  }

  async findItemByBarcode(barcode: string): Promise<Item | null> {
    const rows = await this.query(
      `${ITEM_SELECT} WHERE i.barcode = ?1 AND i.barcode != '' AND i.is_active = 1`,
      [barcode],
    );
    return rows[0] ? rowToItem(rows[0]) : null;
  }

  async upsertItem(input: ItemInput): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("upsert_item", { item: itemToPayload(input, new Date().toISOString()) });
  }

  async importItems(items: ItemInput[]): Promise<ImportRowOutcome[]> {
    const invoke = await this.getInvoke();
    const now = new Date().toISOString();
    return invoke<ImportRowOutcome[]>("import_items", {
      items: items.map((i) => itemToPayload(i, now)),
    });
  }

  async listCustomers(search?: string): Promise<Customer[]> {
    let sql = "SELECT id, name, phone, gstin, address, loyalty_points, created_at, updated_at FROM customers";
    const params: unknown[] = [];
    if (search) {
      sql += " WHERE name LIKE ?1 OR phone LIKE ?2";
      params.push(`%${search}%`, `%${search}%`);
    }
    sql += " ORDER BY name";
    const rows = await this.query(sql, params);
    return rows.map((r) => ({
      id: num(r.id),
      name: str(r.name),
      phone: str(r.phone),
      gstin: str(r.gstin ?? ""),
      address: str(r.address ?? ""),
      loyaltyPoints: num(r.loyalty_points ?? 0),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    }));
  }

  async upsertCustomer(input: CustomerInput): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("upsert_customer", {
      customer: {
        id: input.id ?? null,
        name: input.name,
        phone: input.phone,
        gstin: input.gstin ?? "",
        address: input.address ?? "",
        now: localIsoTimestamp(new Date()),
      },
    });
  }

  async deleteCustomer(id: number): Promise<boolean> {
    const invoke = await this.getInvoke();
    return invoke<boolean>("delete_customer", { customerId: id });
  }

  async recordCustomerPayment(input: CustomerPaymentInput): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("record_customer_payment", {
      payment: {
        customerId: input.customerId,
        amountPaise: input.amountPaise,
        mode: input.mode,
        notes: input.notes ?? "",
        createdAt: input.createdAt ?? localIsoTimestamp(new Date()),
      },
    });
  }

  async listCustomerPayments(customerId: number): Promise<CustomerPayment[]> {
    const invoke = await this.getInvoke();
    return invoke<CustomerPayment[]>("list_customer_payments", { customerId });
  }

  async getCustomerLedger(customerId: number): Promise<CustomerLedgerSummary> {
    const customer = (await this.listCustomers()).find((c) => c.id === customerId);
    if (!customer) throw new Error(`no customer with id ${customerId}`);
    const customerBills = (await this.listBills()).filter(
      (b) => b.customerId === customerId && b.status === "active",
    );
    const bills: LedgerBill[] = [];
    for (const b of customerBills) {
      const detail = await this.getBill(b.id);
      if (!detail) continue;
      bills.push({
        id: b.id,
        number: b.number,
        createdAt: b.createdAt,
        creditPaise: detail.payments.filter((p) => p.mode === "credit").reduce((s, p) => s + p.amountPaise, 0),
      });
    }
    const billIds = new Set(bills.map((b) => b.id));
    const notes = (await this.listCreditNotes()).filter((n) => billIds.has(n.billId));
    return buildCustomerLedger(customer, bills, await this.listCustomerPayments(customerId), notes);
  }

  async createBill(bill: NewBillPayload): Promise<CreatedBill> {
    const invoke = await this.getInvoke();
    return invoke<CreatedBill>("create_bill", { bill });
  }

  async voidBill(billId: number, reason: string): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("void_bill", { billId, reason, voidedAt: new Date().toISOString() });
  }

  async listBills(filter?: BillFilter): Promise<BillSummary[]> {
    let sql = BILL_SELECT;
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter?.search) {
      where.push(`(b.number LIKE ?${params.length + 1} OR cu.name LIKE ?${params.length + 2})`);
      params.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    if (filter?.from) {
      where.push(`b.created_at >= ?${params.length + 1}`);
      params.push(filter.from);
    }
    if (filter?.to) {
      where.push(`b.created_at <= ?${params.length + 1}`);
      params.push(filter.to);
    }
    if (where.length > 0) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY b.created_at DESC, b.id DESC";
    return (await this.query(sql, params)).map(rowToBillSummary);
  }

  async getBill(id: number): Promise<BillDetail | null> {
    const bills = await this.query(`${BILL_SELECT} WHERE b.id = ?1`, [id]);
    const billRow = bills[0];
    if (!billRow) return null;
    const lineRows = await this.query(
      "SELECT id, bill_id, line_no, item_id, name_snapshot, qty_milli, unit_price_paise, tax_rate_bp, tax_paise, total_paise, discount_paise, hsn_code FROM bill_lines WHERE bill_id = ?1 ORDER BY line_no",
      [id],
    );
    const paymentRows = await this.query(
      "SELECT id, bill_id, mode, amount_paise FROM payments WHERE bill_id = ?1 ORDER BY id",
      [id],
    );
    const lines: BillLineRow[] = lineRows.map((r) => ({
      id: num(r.id),
      billId: num(r.bill_id),
      lineNo: num(r.line_no),
      itemId: optNum(r.item_id),
      nameSnapshot: str(r.name_snapshot),
      qtyMilli: num(r.qty_milli),
      unitPricePaise: num(r.unit_price_paise),
      taxRateBp: num(r.tax_rate_bp),
      taxPaise: num(r.tax_paise),
      totalPaise: num(r.total_paise),
      discountPaise: num(r.discount_paise ?? 0),
      hsnCode: str(r.hsn_code ?? ""),
    }));
    const payments: PaymentRow[] = paymentRows.map((r) => ({
      id: num(r.id),
      billId: num(r.bill_id),
      mode: str(r.mode) as PaymentRow["mode"],
      amountPaise: num(r.amount_paise),
    }));
    return { ...rowToBillSummary(billRow), lines, payments };
  }

  async getBillsReportData(filter?: BillFilter): Promise<ReportBill[]> {
    const invoke = await this.getInvoke();
    return invoke<ReportBill[]>("get_bills_report_data", {
      from: filter?.from ?? null,
      to: filter?.to ?? null,
    });
  }

  async adjustStock(
    itemId: number,
    deltaMilli: number,
    reason: "adjustment" | "purchase" | "import",
  ): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("adjust_stock", {
      itemId,
      deltaMilli,
      reason,
      createdAt: new Date().toISOString(),
    });
  }

  async listMovements(itemId?: number): Promise<StockMovementRecord[]> {
    let sql =
      "SELECT id, item_id, delta_milli, reason, ref_type, ref_id, created_at FROM stock_movements";
    const params: unknown[] = [];
    if (itemId !== undefined) {
      sql += " WHERE item_id = ?1";
      params.push(itemId);
    }
    sql += " ORDER BY id DESC LIMIT 500";
    const rows = await this.query(sql, params);
    return rows.map((r) => ({
      id: num(r.id),
      itemId: num(r.item_id),
      deltaMilli: num(r.delta_milli),
      reason: str(r.reason) as StockMovementRecord["reason"],
      refType: r.ref_type == null ? null : (str(r.ref_type) as StockMovementRecord["refType"]),
      refId: r.ref_id == null ? null : str(r.ref_id),
      createdAt: str(r.created_at),
    }));
  }

  // --- B2 images -----------------------------------------------------------

  async setItemPhoto(itemId: number, bytes: Uint8Array, imageHash: string): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("set_item_photo", {
      itemId,
      bytes: Array.from(bytes),
      imageHash,
      now: localIsoTimestamp(new Date()),
    });
  }

  async clearItemPhoto(itemId: number): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("clear_item_photo", { itemId, now: localIsoTimestamp(new Date()) });
  }

  async readItemPhoto(itemId: number): Promise<{ bytes: Uint8Array; imageHash: string | null } | null> {
    const item = await this.getItem(itemId);
    if (!item || item.photoFile === "") return null;
    const invoke = await this.getInvoke();
    const bytes = await invoke<number[]>("read_item_photo", { itemId });
    return { bytes: new Uint8Array(bytes), imageHash: item.imageHash };
  }

  async listItemImages(itemId: number): Promise<ItemImage[]> {
    const invoke = await this.getInvoke();
    const rows = await invoke<Record<string, unknown>[]>("list_item_images", { itemId });
    return (rows || []).map((r) => ({
      id: num(r.id),
      itemId: num(r.itemId ?? r.item_id),
      fileName: str(r.fileName ?? r.file_name),
      imageHash: str(r.imageHash ?? r.image_hash),
      isMain: Boolean(r.isMain ?? r.is_main),
      position: num(r.position),
      remoteImageId: r.remoteImageId == null && r.remote_image_id == null ? null : str(r.remoteImageId ?? r.remote_image_id),
      imageUploadedAt: r.imageUploadedAt == null && r.image_uploaded_at == null ? null : str(r.imageUploadedAt ?? r.image_uploaded_at),
      createdAt: str(r.createdAt ?? r.created_at),
    }));
  }

  async addItemImage(
    itemId: number,
    bytes: Uint8Array,
    imageHash: string,
    isMain = false,
  ): Promise<ItemImage> {
    const invoke = await this.getInvoke();
    const r = await invoke<Record<string, unknown>>("add_item_image", {
      itemId,
      bytes: Array.from(bytes),
      imageHash,
      isMain,
      now: localIsoTimestamp(new Date()),
    });
    return {
      id: num(r.id),
      itemId: num(r.itemId ?? r.item_id),
      fileName: str(r.fileName ?? r.file_name),
      imageHash: str(r.imageHash ?? r.image_hash),
      isMain: Boolean(r.isMain ?? r.is_main),
      position: num(r.position),
      remoteImageId: r.remoteImageId == null && r.remote_image_id == null ? null : str(r.remoteImageId ?? r.remote_image_id),
      imageUploadedAt: r.imageUploadedAt == null && r.image_uploaded_at == null ? null : str(r.imageUploadedAt ?? r.image_uploaded_at),
      createdAt: str(r.createdAt ?? r.created_at),
    };
  }

  async deleteItemImage(imageId: number): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("delete_item_image", { imageId, now: localIsoTimestamp(new Date()) });
  }

  async setItemImageMain(imageId: number): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("set_item_image_main", { imageId, now: localIsoTimestamp(new Date()) });
  }

  async readItemImage(imageId: number): Promise<{ bytes: Uint8Array; imageHash: string } | null> {
    const invoke = await this.getInvoke();
    try {
      const bytes = await invoke<number[]>("read_item_image", { imageId });
      const rows = await this.query("SELECT image_hash FROM item_images WHERE id = ?", [imageId]);
      const firstRow = rows[0];
      const hash = firstRow ? str(firstRow.image_hash) : "";
      return { bytes: new Uint8Array(bytes), imageHash: hash };
    } catch {
      return null;
    }
  }

  async recordImageUploads(
    uploads: readonly { itemId: number; imageHash: string; uploadedAt: string }[],
  ): Promise<void> {
    if (uploads.length === 0) return;
    const invoke = await this.getInvoke();
    await invoke("record_image_uploads", { uploads });
  }

  // --- B1 held bills -------------------------------------------------------

  async listHeldBills(): Promise<HeldBill[]> {
    const rows = await this.query(
      "SELECT id, label, customer_id, lines_json, created_at FROM held_bills ORDER BY created_at",
    );
    return rows.map((r) => ({
      id: num(r.id),
      label: str(r.label),
      customerId: r.customer_id === null ? null : num(r.customer_id),
      lines: JSON.parse(str(r.lines_json)) as HeldBill["lines"],
      createdAt: str(r.created_at),
    }));
  }

  async saveHeldBill(bill: HeldBillInput): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("save_held_bill", {
      bill: { ...bill, id: bill.id ?? null, createdAt: localIsoTimestamp(new Date()) },
    });
  }

  async takeHeldBill(id: number): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("take_held_bill", { id });
  }

  // --- B5 sync -------------------------------------------------------------

  async listOutbox(status?: "pending" | "done"): Promise<OutboxRow[]> {
    const rows = await this.query(
      status === undefined
        ? "SELECT id, idempotency_key, payload_json, attempts, next_attempt_at, status FROM outbox ORDER BY id"
        : "SELECT id, idempotency_key, payload_json, attempts, next_attempt_at, status FROM outbox WHERE status = ?1 ORDER BY id",
      status === undefined ? [] : [status],
    );
    return rows.map((r) => {
      const payload = JSON.parse(str(r.payload_json)) as {
        externalId: string;
        deltaUnits: number;
        reason: OutboxRow["reason"];
      };
      return {
        id: num(r.id),
        idempotencyKey: str(r.idempotency_key),
        externalId: payload.externalId,
        deltaUnits: payload.deltaUnits,
        reason: payload.reason,
        attempts: num(r.attempts),
        nextAttemptAt: r.next_attempt_at === null ? null : str(r.next_attempt_at),
        status: (str(r.status) === "done" ? "done" : "pending") as OutboxRow["status"],
      };
    });
  }

  async recordOutboxResults(
    results: readonly { idempotencyKey: string; outcome: "done" | "retry"; nextAttemptAt?: string }[],
  ): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("record_outbox_results", {
      results: results.map((r) => ({
        idempotencyKey: r.idempotencyKey,
        outcome: r.outcome,
        nextAttemptAt: r.nextAttemptAt ?? null,
      })),
    });
  }

  async dropOutbox(keys: readonly string[]): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("drop_outbox", { keys });
  }

  async getSyncCursor(key: string): Promise<string | null> {
    const rows = await this.query("SELECT value FROM sync_state WHERE key = ?1", [key]);
    return rows[0] ? str(rows[0].value) : null;
  }

  async setSyncCursor(key: string, value: string): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("set_sync_cursor", { key, value });
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
    const invoke = await this.getInvoke();
    return invoke<{ externalId: string; itemId: number | null; deltaMilli: number }[]>(
      "apply_stock_pull",
      { cursor: nextCursor, moves },
    );
  }

  async recordRemoteCatalog(items: readonly RemoteItemLink[]): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("record_remote_catalog", { items });
  }

  async applyReconcileFixes(fixes: readonly ReconcileFix[]): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("apply_reconcile_fixes", {
      fixes: fixes.map((f) => ({
        itemId: f.itemId,
        externalId: f.externalId,
        kind: f.kind,
        pricePaise: f.pricePaise ?? null,
        stockUnits: f.stockUnits ?? null,
        isActive: f.isActive ?? null,
        pullToLocal: f.pullToLocal === true,
      })),
    });
  }

  // --- generic settings ----------------------------------------------------

  async getAppSetting(key: string): Promise<string | null> {
    const invoke = await this.getInvoke();
    return invoke<string | null>("get_app_setting", { key });
  }

  async setAppSetting(key: string, value: string | null): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("set_app_setting", { key, value });
  }

  // --- Phase 2: Credit Notes ------------------------------------------------

  async createCreditNote(payload: NewCreditNotePayload): Promise<{ creditNoteId: number; number: string }> {
    const invoke = await this.getInvoke();
    return invoke<{ creditNoteId: number; number: string }>("create_credit_note", {
      creditNote: {
        billId: payload.billId,
        reason: payload.reason,
        createdAt: payload.createdAt || new Date().toISOString(),
        lines: payload.lines.map((l) => ({
          itemId: l.itemId,
          nameSnapshot: l.nameSnapshot,
          qtyMilli: l.qtyMilli,
          unitPricePaise: l.unitPricePaise,
          taxRateBp: l.taxRateBp,
          taxPaise: l.taxPaise,
          totalPaise: l.totalPaise,
          hsnCode: l.hsnCode ?? "",
        })),
      },
    });
  }

  async listCreditNotes(billId?: number): Promise<CreditNote[]> {
    const invoke = await this.getInvoke();
    return invoke<CreditNote[]>("list_credit_notes", { billId: billId ?? null });
  }

  async getCreditNote(id: number): Promise<CreditNote | null> {
    const invoke = await this.getInvoke();
    return invoke<CreditNote | null>("get_credit_note", { id });
  }

  // --- Phase 2: Suppliers & Purchases ---------------------------------------

  async listSuppliers(search?: string): Promise<Supplier[]> {
    const invoke = await this.getInvoke();
    return invoke<Supplier[]>("list_suppliers", { search: search ?? null });
  }

  async upsertSupplier(input: SupplierInput): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("upsert_supplier", {
      supplier: {
        id: input.id ?? null,
        name: input.name,
        phone: input.phone ?? "",
        gstin: input.gstin ?? "",
        address: input.address ?? "",
        createdAt: new Date().toISOString(),
      },
    });
  }

  async deleteSupplier(id: number): Promise<boolean> {
    const invoke = await this.getInvoke();
    return invoke<boolean>("delete_supplier", { supplierId: id });
  }

  async createPurchase(payload: NewPurchasePayload): Promise<{ purchaseId: number }> {
    const invoke = await this.getInvoke();
    const purchaseId = await invoke<number>("create_purchase", {
      purchase: {
        supplierId: payload.supplierId,
        invoiceNo: payload.invoiceNo,
        invoiceDate: payload.invoiceDate,
        status: payload.status ?? "received",
        createdAt: payload.createdAt || new Date().toISOString(),
        lines: payload.lines.map((l) => ({
          itemId: l.itemId,
          nameSnapshot: l.nameSnapshot,
          qtyMilli: l.qtyMilli,
          unitCostPaise: l.unitCostPaise,
          taxRateBp: l.taxRateBp,
        })),
      },
    });
    return { purchaseId };
  }

  async listPurchases(supplierId?: number): Promise<Purchase[]> {
    const invoke = await this.getInvoke();
    return invoke<Purchase[]>("list_purchases", { supplierId: supplierId ?? null });
  }

  async getPurchase(id: number): Promise<Purchase | null> {
    const invoke = await this.getInvoke();
    return invoke<Purchase | null>("get_purchase", { id });
  }

  // --- Phase 2: Users & Roles & Audit ---------------------------------------

  async listUsers(): Promise<User[]> {
    const invoke = await this.getInvoke();
    return invoke<User[]>("list_users");
  }

  async upsertUser(input: UserInput): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("upsert_user", {
      user: {
        id: input.id ?? null,
        name: input.name,
        role: input.role,
        pin: input.pin,
        isActive: input.isActive ?? true,
        createdAt: new Date().toISOString(),
      },
    });
  }

  async verifyPin(pin: string, requiredRole?: UserRole): Promise<User | null> {
    const invoke = await this.getInvoke();
    const res = await invoke<(User & { sessionToken?: string }) | null>("verify_pin", {
      pin,
      requiredRole: requiredRole ?? null,
    });
    if (!res) return null;
    const { sessionToken, ...user } = res;
    // A plain login starts a session; a role check ("is this the owner's PIN?") does not.
    if (sessionToken) setSessionToken(sessionToken);
    return user;
  }

  async logout(): Promise<void> {
    const invoke = await this.getInvoke();
    try {
      await invoke("logout", {});
    } finally {
      setSessionToken(null);
    }
  }

  async recordAuditLog(input: AuditLogInput): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("record_audit_log", {
      auditLog: {
        userId: input.userId ?? null,
        action: input.action,
        details: input.details ?? "",
        createdAt: input.createdAt || new Date().toISOString(),
      },
    });
  }

  async listAuditLogs(limit = 100): Promise<AuditLog[]> {
    const invoke = await this.getInvoke();
    return invoke<AuditLog[]>("list_audit_logs", { limit });
  }

  // --- Phase 2: Stock Audit -------------------------------------------------

  async applyStockAudit(discrepancies: StockDiscrepancyInput[]): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("apply_stock_audit", {
      discrepancies: discrepancies.map((d) => ({
        itemId: d.itemId,
        physicalCountMilli: d.physicalCountMilli,
        reason: d.reason ?? null,
        createdAt: d.createdAt || new Date().toISOString(),
      })),
    });
  }

  // --- Phase 3: Batches & Expiry --------------------------------------------

  async upsertBatch(input: BatchInput): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("upsert_batch", {
      batch: {
        id: input.id ?? null,
        itemId: input.itemId,
        batchNo: input.batchNo,
        mfgDate: input.mfgDate ?? null,
        expiryDate: input.expiryDate,
        costPricePaise: input.costPricePaise,
        mrpPaise: input.mrpPaise,
        stockMilli: input.stockMilli,
        createdAt: input.createdAt || new Date().toISOString(),
      },
    });
  }

  async listBatchesForItem(itemId: number): Promise<ItemBatch[]> {
    const invoke = await this.getInvoke();
    const rows = await invoke<Record<string, unknown>[]>("list_batches_for_item", { itemId });
    return (rows || []).map((r) => ({
      id: Number(r.id),
      itemId: Number(r.itemId ?? r.item_id),
      batchNo: String(r.batchNo ?? r.batch_no ?? ""),
      mfgDate: (r.mfgDate ?? r.mfg_date ?? null) as string | null,
      expiryDate: String(r.expiryDate ?? r.expiry_date ?? ""),
      costPricePaise: Number(r.costPricePaise ?? r.cost_price_paise ?? 0),
      mrpPaise: Number(r.mrpPaise ?? r.mrp_paise ?? 0),
      stockMilli: Number(r.stockMilli ?? r.stock_milli ?? 0),
      createdAt: String(r.createdAt ?? r.created_at ?? ""),
    }));
  }

  async listExpiringBatches(daysThreshold: number): Promise<ItemBatch[]> {
    const invoke = await this.getInvoke();
    const rows = await invoke<Record<string, unknown>[]>("list_expiring_batches", {
      daysThreshold,
      nowIso: new Date().toISOString().slice(0, 10),
    });
    return (rows || []).map((r) => ({
      id: Number(r.id),
      itemId: Number(r.itemId ?? r.item_id),
      batchNo: String(r.batchNo ?? r.batch_no ?? ""),
      mfgDate: (r.mfgDate ?? r.mfg_date ?? null) as string | null,
      expiryDate: String(r.expiryDate ?? r.expiry_date ?? ""),
      costPricePaise: Number(r.costPricePaise ?? r.cost_price_paise ?? 0),
      mrpPaise: Number(r.mrpPaise ?? r.mrp_paise ?? 0),
      stockMilli: Number(r.stockMilli ?? r.stock_milli ?? 0),
      createdAt: String(r.createdAt ?? r.created_at ?? ""),
    }));
  }

  // --- Phase 3: Customer Loyalty Points -------------------------------------

  async updateCustomerLoyalty(
    customerId: number,
    pointsDelta: number,
    billId?: number | null,
    reason = "",
  ): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("update_customer_loyalty", {
      customerId,
      pointsDelta,
      billId: billId ?? null,
      reason,
      createdAt: new Date().toISOString(),
    });
  }

  async getCustomerLoyaltyBalance(customerId: number): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("get_customer_loyalty_balance", { customerId });
  }

  async listLoyaltyTransactions(customerId: number): Promise<LoyaltyTransaction[]> {
    const invoke = await this.getInvoke();
    const rows = await invoke<Record<string, unknown>[]>("list_loyalty_transactions", { customerId });
    return (rows || []).map((r) => ({
      id: Number(r.id),
      customerId: Number(r.customerId ?? r.customer_id),
      billId: (r.billId ?? r.bill_id ?? null) as number | null,
      pointsDelta: Number(r.pointsDelta ?? r.points_delta ?? 0),
      reason: String(r.reason ?? ""),
      createdAt: String(r.createdAt ?? r.created_at ?? ""),
    }));
  }

  // --- Phase 3: Multi-Barcodes ----------------------------------------------

  async upsertItemBarcode(
    itemId: number,
    barcode: string,
    packQtyMilli = 1000,
    label = "",
  ): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("upsert_item_barcode", {
      itemId,
      barcode,
      packQtyMilli,
      label,
    });
  }

  async listItemBarcodes(itemId: number): Promise<ItemBarcode[]> {
    const invoke = await this.getInvoke();
    const rows = await invoke<Record<string, unknown>[]>("list_item_barcodes", { itemId });
    return (rows || []).map((r) => ({
      id: Number(r.id),
      itemId: Number(r.itemId ?? r.item_id),
      barcode: String(r.barcode ?? ""),
      packQtyMilli: Number(r.packQtyMilli ?? r.pack_qty_milli ?? 1000),
      label: String(r.label ?? ""),
    }));
  }

  async deleteItemBarcode(barcodeId: number): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke<void>("delete_item_barcode", { barcodeId });
  }

  async lookupItemByAnyBarcode(barcode: string): Promise<BarcodeLookupResult | null> {
    const invoke = await this.getInvoke();
    const r = await invoke<Record<string, unknown> | null>("lookup_item_by_any_barcode", { barcode });
    if (!r) return null;
    return {
      itemId: Number(r.itemId ?? r.item_id),
      itemName: String(r.itemName ?? r.item_name ?? ""),
      barcode: String(r.barcode ?? ""),
      packQtyMilli: Number(r.packQtyMilli ?? r.pack_qty_milli ?? 1000),
      pricePaise: Number(r.pricePaise ?? r.price_paise ?? 0),
    };
  }

  // --- Phase 3: Day-End Closing & Z-Report -----------------------------------

  async createDayEndClosure(input: DayEndClosureInput): Promise<number> {
    const invoke = await this.getInvoke();
    return invoke<number>("create_day_end_closure", {
      closure: {
        closureDate: input.closureDate,
        userId: input.userId ?? null,
        openingCashPaise: input.openingCashPaise,
        cashSalesPaise: input.cashSalesPaise,
        creditReceivedPaise: input.creditReceivedPaise,
        cashRefundsPaise: input.cashRefundsPaise,
        expectedCashPaise: input.expectedCashPaise,
        actualCashPaise: input.actualCashPaise,
        variancePaise: input.variancePaise,
        totalBillsCount: input.totalBillsCount,
        totalSalesPaise: input.totalSalesPaise,
        notes: input.notes ?? "",
        createdAt: input.createdAt || new Date().toISOString(),
      },
    });
  }

  async listDayEndClosures(fromDate?: string, toDate?: string): Promise<DayEndClosure[]> {
    const invoke = await this.getInvoke();
    const rows = await invoke<Record<string, unknown>[]>("list_day_end_closures", {
      fromDate: fromDate ?? null,
      toDate: toDate ?? null,
    });
    return (rows || []).map((r) => ({
      id: Number(r.id),
      closureDate: String(r.closureDate ?? r.closure_date ?? ""),
      userId: (r.userId ?? r.user_id ?? null) as number | null,
      userName: (r.userName ?? r.user_name ?? undefined) as string | undefined,
      openingCashPaise: Number(r.openingCashPaise ?? r.opening_cash_paise ?? 0),
      cashSalesPaise: Number(r.cashSalesPaise ?? r.cash_sales_paise ?? 0),
      creditReceivedPaise: Number(r.creditReceivedPaise ?? r.credit_received_paise ?? 0),
      cashRefundsPaise: Number(r.cashRefundsPaise ?? r.cash_refunds_paise ?? 0),
      expectedCashPaise: Number(r.expectedCashPaise ?? r.expected_cash_paise ?? 0),
      actualCashPaise: Number(r.actualCashPaise ?? r.actual_cash_paise ?? 0),
      variancePaise: Number(r.variancePaise ?? r.variance_paise ?? 0),
      totalBillsCount: Number(r.totalBillsCount ?? r.total_bills_count ?? 0),
      totalSalesPaise: Number(r.totalSalesPaise ?? r.total_sales_paise ?? 0),
      notes: String(r.notes ?? ""),
      createdAt: String(r.createdAt ?? r.created_at ?? ""),
    }));
  }

  async getDayEndExpectedCash(datePrefix: string): Promise<DayEndExpectedCash> {
    const invoke = await this.getInvoke();
    const r = await invoke<Record<string, unknown>>("get_day_end_expected_cash", { datePrefix });
    return {
      cashSalesPaise: Number(r?.cashSalesPaise ?? r?.cash_sales_paise ?? 0),
      creditReceivedPaise: Number(r?.creditReceivedPaise ?? r?.credit_received_paise ?? 0),
      cashRefundsPaise: Number(r?.cashRefundsPaise ?? r?.cash_refunds_paise ?? 0),
      totalBillsCount: Number(r?.totalBillsCount ?? r?.total_bills_count ?? 0),
      totalSalesPaise: Number(r?.totalSalesPaise ?? r?.total_sales_paise ?? 0),
    };
  }
}
