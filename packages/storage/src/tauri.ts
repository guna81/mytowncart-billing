// SPDX-License-Identifier: Apache-2.0
/**
 * Tauri adapter: bridges the repository interface to the Rust shell's typed
 * commands via `@tauri-apps/api` invoke. Reads use the generic parameterized
 * `query_rows` command; every multi-table write is a dedicated command.
 */

import { isUnitKind, localIsoTimestamp, type UnitKind } from "@mytowncart-billing/core";
import type { BillingRepository, BillFilter, CreatedBill, ItemFilter, NewBillPayload } from "./repository";
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

type Row = Record<string, unknown>;

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

async function invoker(): Promise<InvokeFn> {
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
    createdAt: str(r.created_at),
    voidedAt: r.voided_at == null ? null : str(r.voided_at),
    voidReason: r.void_reason == null ? null : str(r.void_reason),
  };
}

const ITEM_SELECT =
  "SELECT i.id, i.name, i.barcode, i.category_id, c.name AS category_name, i.unit_kind, " +
  "i.price_paise, i.mrp_paise, i.tax_rate_bp, i.stock_milli, i.is_active, i.photo_path, " +
  "i.publish_state, i.remote_product_id, i.remote_variant_id, i.content_hash, " +
  "i.photo_path, i.image_hash, i.image_uploaded_at, i.remote_hash, i.updated_at " +
  "FROM items i LEFT JOIN categories c ON c.id = i.category_id";

const BILL_SELECT =
  "SELECT b.id, b.number, b.fy, b.status, b.customer_id, cu.name AS customer_name, " +
  "b.subtotal_paise, b.tax_paise, b.total_paise, b.created_at, b.voided_at, b.void_reason " +
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
    now,
  };
}

export class TauriRepository implements BillingRepository {
  readonly kind = "tauri" as const;

  private async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const invoke = await invoker();
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
    const invoke = await invoker();
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
    const invoke = await invoker();
    return invoke<number>("upsert_category", {
      category: { id: input.id ?? null, name: input.name },
    });
  }

  async setCategoryMarketplaceId(
    categoryId: number,
    marketplaceCategoryId: string | null,
  ): Promise<void> {
    const invoke = await invoker();
    await invoke<void>("record_publish", {
      outcomes: [],
      categoryMappings: [{ categoryId, marketplaceCategoryId }],
    });
  }

  async recordPublish(
    outcomes: readonly PublishOutcome[],
    marketplaceCategoryIds: ReadonlyMap<number, string>,
  ): Promise<void> {
    const invoke = await invoker();
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
      where.push(`(i.name LIKE ?${params.length + 1} OR i.barcode LIKE ?${params.length + 2})`);
      params.push(`%${filter.search}%`, `%${filter.search}%`);
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
    const invoke = await invoker();
    return invoke<number>("upsert_item", { item: itemToPayload(input, new Date().toISOString()) });
  }

  async importItems(items: ItemInput[]): Promise<ImportRowOutcome[]> {
    const invoke = await invoker();
    const now = new Date().toISOString();
    return invoke<ImportRowOutcome[]>("import_items", {
      items: items.map((i) => itemToPayload(i, now)),
    });
  }

  async listCustomers(search?: string): Promise<Customer[]> {
    let sql = "SELECT id, name, phone, created_at, updated_at FROM customers";
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
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    }));
  }

  async upsertCustomer(input: { id?: number; name: string; phone: string }): Promise<number> {
    const invoke = await invoker();
    return invoke<number>("upsert_customer", {
      customer: { id: input.id ?? null, name: input.name, phone: input.phone, now: new Date().toISOString() },
    });
  }

  async createBill(bill: NewBillPayload): Promise<CreatedBill> {
    const invoke = await invoker();
    return invoke<CreatedBill>("create_bill", { bill });
  }

  async voidBill(billId: number, reason: string): Promise<void> {
    const invoke = await invoker();
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
      "SELECT id, bill_id, line_no, item_id, name_snapshot, qty_milli, unit_price_paise, tax_rate_bp, tax_paise, total_paise FROM bill_lines WHERE bill_id = ?1 ORDER BY line_no",
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
    }));
    const payments: PaymentRow[] = paymentRows.map((r) => ({
      id: num(r.id),
      billId: num(r.bill_id),
      mode: str(r.mode) as PaymentRow["mode"],
      amountPaise: num(r.amount_paise),
    }));
    return { ...rowToBillSummary(billRow), lines, payments };
  }

  async adjustStock(
    itemId: number,
    deltaMilli: number,
    reason: "adjustment" | "purchase" | "import",
  ): Promise<number> {
    const invoke = await invoker();
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
    const invoke = await invoker();
    await invoke("set_item_photo", {
      itemId,
      bytes: Array.from(bytes),
      imageHash,
      now: localIsoTimestamp(new Date()),
    });
  }

  async clearItemPhoto(itemId: number): Promise<void> {
    const invoke = await invoker();
    await invoke("clear_item_photo", { itemId, now: localIsoTimestamp(new Date()) });
  }

  async readItemPhoto(itemId: number): Promise<{ bytes: Uint8Array; imageHash: string | null } | null> {
    const item = await this.getItem(itemId);
    if (!item || item.photoFile === "") return null;
    const invoke = await invoker();
    const bytes = await invoke<number[]>("read_item_photo", { itemId });
    return { bytes: new Uint8Array(bytes), imageHash: item.imageHash };
  }

  async recordImageUploads(
    uploads: readonly { itemId: number; imageHash: string; uploadedAt: string }[],
  ): Promise<void> {
    if (uploads.length === 0) return;
    const invoke = await invoker();
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
    const invoke = await invoker();
    return invoke<number>("save_held_bill", {
      bill: { ...bill, id: bill.id ?? null, createdAt: localIsoTimestamp(new Date()) },
    });
  }

  async takeHeldBill(id: number): Promise<void> {
    const invoke = await invoker();
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
    const invoke = await invoker();
    await invoke("record_outbox_results", {
      results: results.map((r) => ({
        idempotencyKey: r.idempotencyKey,
        outcome: r.outcome,
        nextAttemptAt: r.nextAttemptAt ?? null,
      })),
    });
  }

  async dropOutbox(keys: readonly string[]): Promise<void> {
    const invoke = await invoker();
    await invoke("drop_outbox", { keys });
  }

  async getSyncCursor(key: string): Promise<string | null> {
    const rows = await this.query("SELECT value FROM sync_state WHERE key = ?1", [key]);
    return rows[0] ? str(rows[0].value) : null;
  }

  async setSyncCursor(key: string, value: string): Promise<void> {
    const invoke = await invoker();
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
    const invoke = await invoker();
    return invoke<{ externalId: string; itemId: number | null; deltaMilli: number }[]>(
      "apply_stock_pull",
      { cursor: nextCursor, moves },
    );
  }

  async recordRemoteCatalog(items: readonly RemoteItemLink[]): Promise<number> {
    const invoke = await invoker();
    return invoke<number>("record_remote_catalog", { items });
  }

  async listRemoteOrders(): Promise<RemoteOrderRecord[]> {
    const rows = await this.query(
      "SELECT id, status, payment_status, payment_method, total_paise, placed_at, updated_at, lines_json, synced_at FROM remote_orders ORDER BY placed_at DESC LIMIT 200",
    );
    return rows.map((r) => ({
      id: str(r.id),
      status: str(r.status),
      paymentStatus: str(r.payment_status),
      paymentMethod: str(r.payment_method),
      totalPaise: num(r.total_paise),
      placedAt: str(r.placed_at),
      updatedAt: str(r.updated_at),
      lines: JSON.parse(str(r.lines_json)) as RemoteOrderRecord["lines"],
      syncedAt: str(r.synced_at),
    }));
  }

  async recordRemoteOrders(orders: readonly RemoteOrderRecord[]): Promise<number> {
    const invoke = await invoker();
    return invoke<number>("record_orders", {
      orders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod,
        totalPaise: o.totalPaise,
        placedAt: o.placedAt,
        updatedAt: o.updatedAt,
        linesJson: JSON.stringify(o.lines),
        syncedAt: o.syncedAt,
      })),
    });
  }

  async applyReconcileFixes(fixes: readonly ReconcileFix[]): Promise<void> {
    const invoke = await invoker();
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
    const invoke = await invoker();
    return invoke<string | null>("get_app_setting", { key });
  }

  async setAppSetting(key: string, value: string | null): Promise<void> {
    const invoke = await invoker();
    await invoke("set_app_setting", { key, value });
  }
}
