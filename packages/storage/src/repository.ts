// SPDX-License-Identifier: Apache-2.0
/**
 * The storage port (roadmap §8.1/D2): every screen talks to this interface,
 * never to SQL or Tauri directly. Two adapters ship in B1:
 *  - `TauriRepository` — bridges to the Rust shell's typed commands
 *    (SQLite, one transaction per multi-table write).
 *  - `MemoryRepository` — same semantics in-memory, for Vitest and for the
 *    web UI running in a plain browser (dev/Playwright).
 */

import type {
  PaymentMode,
  ReportBill,
  UnitKind,
} from "@mytowncart-billing/core";
import type {
  AuditLog,
  AuditLogInput,
  BarcodeLookupResult,
  BatchInput,
  BillDetail,
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

/** Fully-computed new bill, as produced by core's `computeBill` + the UI. */
export interface NewBillPayload {
  fy: string;
  prefix: string;
  customerId: number | null;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  discountPaise?: number;
  roundOffPaise?: number;
  notes?: string;
  /** Loyalty points earned / redeemed by this sale; applied in the same transaction as the bill. */
  loyaltyEarned?: number;
  loyaltyRedeemed?: number;
  createdAt: string;
  lines: {
    itemId: number;
    nameSnapshot: string;
    qtyMilli: number;
    unitPricePaise: number;
    taxRateBp: number;
    taxPaise: number;
    totalPaise: number;
    discountPaise?: number;
    hsnCode?: string;
  }[];
  payments: { mode: PaymentMode; amountPaise: number }[];
}

export interface CreatedBill {
  billId: number;
  number: string;
  seq: number;
}

export interface ItemFilter {
  search?: string;
  activeOnly?: boolean;
}

export interface BillFilter {
  search?: string;
  /** Inclusive ISO date/datetime bounds on created_at. */
  from?: string;
  to?: string;
}

export interface BillingRepository {
  readonly kind: "tauri" | "memory" | "http";

  getShopProfile(): Promise<ShopProfile | null>;
  saveShopProfile(profile: Omit<ShopProfile, "updatedAt"> & { updatedAt?: string }): Promise<void>;

  listCategories(): Promise<Category[]>;
  upsertCategory(input: { id?: number; name: string }): Promise<number>;
  /** First-run category mapping: local category -> marketplace category uuid. */
  setCategoryMarketplaceId(categoryId: number, marketplaceCategoryId: string | null): Promise<void>;

  listItems(filter?: ItemFilter): Promise<Item[]>;
  getItem(id: number): Promise<Item | null>;
  findItemByBarcode(barcode: string): Promise<Item | null>;
  upsertItem(input: ItemInput): Promise<number>;
  /** CSV bulk import with per-row isolation: one bad row never fails the batch. */
  importItems(items: ItemInput[]): Promise<ImportRowOutcome[]>;
  /**
   * Persist a publish run atomically: items linked to the marketplace now
   * carry their remote ids, published hash and state. Remote ids and hashes
   * are kept even when the run failed, so a retry re-sends the same items.
   */
  recordPublish(
    outcomes: readonly PublishOutcome[],
    marketplaceCategoryIds: ReadonlyMap<number, string>,
  ): Promise<void>;

  /** B2/D9: attach a photo to an item (replaces any previous one). */
  setItemPhoto(itemId: number, bytes: Uint8Array, imageHash: string): Promise<void>;
  clearItemPhoto(itemId: number): Promise<void>;
  /** Bytes of an item's photo, or null when it has none. */
  readItemPhoto(itemId: number): Promise<{ bytes: Uint8Array; imageHash: string | null } | null>;
  /** Multi-image support for items */
  listItemImages(itemId: number): Promise<ItemImage[]>;
  addItemImage(itemId: number, bytes: Uint8Array, imageHash: string, isMain?: boolean): Promise<ItemImage>;
  deleteItemImage(imageId: number): Promise<void>;
  setItemImageMain(imageId: number): Promise<void>;
  readItemImage(imageId: number): Promise<{ bytes: Uint8Array; imageHash: string } | null>;
  /** Acknowledge uploaded photos (matched by hash; stale acks are ignored). */
  recordImageUploads(
    uploads: readonly { itemId: number; imageHash: string; uploadedAt: string }[],
  ): Promise<void>;

  listCustomers(search?: string): Promise<Customer[]>;
  upsertCustomer(input: CustomerInput): Promise<number>;
  deleteCustomer(id: number): Promise<boolean>;
  recordCustomerPayment(input: CustomerPaymentInput): Promise<number>;
  listCustomerPayments(customerId: number): Promise<CustomerPayment[]>;
  getCustomerLedger(customerId: number): Promise<CustomerLedgerSummary>;

  /** Allocates the invoice number and persists bill+lines+payments+stock atomically. */
  createBill(bill: NewBillPayload): Promise<CreatedBill>;
  voidBill(billId: number, reason: string): Promise<void>;
  listBills(filter?: BillFilter): Promise<BillSummary[]>;
  getBill(id: number): Promise<BillDetail | null>;
  /** Batch query fetching bills with their lines and payments (N+1 query fix for reports). */
  getBillsReportData(filter?: BillFilter): Promise<ReportBill[]>;

  adjustStock(itemId: number, deltaMilli: number, reason: "adjustment" | "purchase" | "import"): Promise<number>;
  listMovements(itemId?: number): Promise<StockMovementRecord[]>;

  /** Parked bills at the till; survive a restart in the desktop shell. */
  listHeldBills(): Promise<HeldBill[]>;
  saveHeldBill(bill: HeldBillInput): Promise<number>;
  takeHeldBill(id: number): Promise<void>;

  // --- B5 two-way sync -----------------------------------------------------

  listOutbox(status?: "pending" | "done"): Promise<OutboxRow[]>;
  /** Record push results: `done` is terminal, `retry` schedules the next try. */
  recordOutboxResults(
    results: readonly { idempotencyKey: string; outcome: "done" | "retry"; nextAttemptAt?: string }[],
  ): Promise<void>;
  /** Retire rows the marketplace can never accept (unpublished item, etc.). */
  dropOutbox(keys: readonly string[]): Promise<void>;
  getSyncCursor(key: string): Promise<string | null>;
  setSyncCursor(key: string, value: string): Promise<void>;
  /**
   * Apply one remote stock page and advance `stock_cursor` to `nextCursor` in
   * the same transaction, so a crash can never replay or skip a page.
   */
  applyStockPull(
    nextCursor: string,
    moves: readonly {
      externalId: string;
      deltaUnits: number;
      reason: "online_order" | "order_cancel" | "adjustment";
      createdAt: string;
    }[],
  ): Promise<{ externalId: string; itemId: number | null; deltaMilli: number }[]>;
  /** Store what the marketplace currently holds for each linked item. */
  recordRemoteCatalog(items: readonly RemoteItemLink[]): Promise<number>;
  /** Reconcile with "local wins": write local price/stock into the marketplace. */
  applyReconcileFixes(fixes: readonly ReconcileFix[]): Promise<void>;

  // --- generic JSON documents (backup/pilot settings) -----------------------

  getAppSetting(key: string): Promise<string | null>;
  setAppSetting(key: string, value: string | null): Promise<void>;

  // --- Phase 2: Credit Notes ------------------------------------------------
  createCreditNote(payload: NewCreditNotePayload): Promise<{ creditNoteId: number; number: string }>;
  listCreditNotes(billId?: number): Promise<CreditNote[]>;
  getCreditNote(id: number): Promise<CreditNote | null>;

  // --- Phase 2: Suppliers & Purchases ---------------------------------------
  listSuppliers(search?: string): Promise<Supplier[]>;
  upsertSupplier(input: SupplierInput): Promise<number>;
  deleteSupplier(id: number): Promise<boolean>;
  createPurchase(payload: NewPurchasePayload): Promise<{ purchaseId: number }>;
  listPurchases(supplierId?: number): Promise<Purchase[]>;
  getPurchase(id: number): Promise<Purchase | null>;

  // --- Phase 2: Users & Roles & Audit ---------------------------------------
  listUsers(): Promise<User[]>;
  upsertUser(input: UserInput): Promise<number>;
  /** Checks a PIN. A plain login (no `requiredRole`) also starts the session used to authorise sensitive commands. */
  verifyPin(pin: string, requiredRole?: UserRole): Promise<User | null>;
  /** Ends the current login session (locks the terminal). */
  logout(): Promise<void>;
  recordAuditLog(input: AuditLogInput): Promise<number>;
  listAuditLogs(limit?: number): Promise<AuditLog[]>;

  // --- Phase 2: Stock Audit -------------------------------------------------
  applyStockAudit(discrepancies: StockDiscrepancyInput[]): Promise<number>;

  // --- Phase 3: Batches & Expiry --------------------------------------------
  upsertBatch(input: BatchInput): Promise<number>;
  listBatchesForItem(itemId: number): Promise<ItemBatch[]>;
  listExpiringBatches(daysThreshold: number): Promise<ItemBatch[]>;

  // --- Phase 3: Customer Loyalty Points -------------------------------------
  updateCustomerLoyalty(customerId: number, pointsDelta: number, billId?: number | null, reason?: string): Promise<number>;
  getCustomerLoyaltyBalance(customerId: number): Promise<number>;
  listLoyaltyTransactions(customerId: number): Promise<LoyaltyTransaction[]>;

  // --- Phase 3: Multi-Barcodes ----------------------------------------------
  upsertItemBarcode(itemId: number, barcode: string, packQtyMilli?: number, label?: string): Promise<number>;
  listItemBarcodes(itemId: number): Promise<ItemBarcode[]>;
  deleteItemBarcode(barcodeId: number): Promise<void>;
  lookupItemByAnyBarcode(barcode: string): Promise<BarcodeLookupResult | null>;

  // --- Phase 3: Day-End Closing & Z-Report -----------------------------------
  createDayEndClosure(input: DayEndClosureInput): Promise<number>;
  listDayEndClosures(fromDate?: string, toDate?: string): Promise<DayEndClosure[]>;
  getDayEndExpectedCash(datePrefix: string): Promise<DayEndExpectedCash>;
}

export type {
  AuditLog,
  AuditLogInput,
  BarcodeLookupResult,
  BatchInput,
  CreditNote,
  CreditNoteLine,
  DayEndClosure,
  DayEndClosureInput,
  DayEndExpectedCash,
  ItemBarcode,
  ItemBatch,
  LoyaltyTransaction,
  NewCreditNotePayload,
  NewPurchasePayload,
  Purchase,
  PurchaseLine,
  StockDiscrepancyInput,
  Supplier,
  SupplierInput,
  UnitKind,
  User,
  UserInput,
  UserRole,
};
