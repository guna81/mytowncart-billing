// SPDX-License-Identifier: Apache-2.0
/**
 * Row types shared by the storage adapters and the UI. Field names are
 * camelCase; the SQLite/Tauri bridge maps them to the snake_case columns of
 * the §8.3 schema.
 */

import type { MovementReason, MovementRefType, PaymentMode, UnitKind } from "@mytowncart-billing/core";

export interface ShopProfile {
  name: string;
  gstEnabled: boolean;
  pricesIncludeTax: boolean;
  invoicePrefix: string;
  address: string;
  phone: string;
  gstin: string;
  receiptFooter: string;
  lowStockThresholdMilli: number;
  updatedAt: string;
}

export const DEFAULT_SHOP_PROFILE: Omit<ShopProfile, "name" | "updatedAt"> = {
  gstEnabled: false,
  pricesIncludeTax: true,
  invoicePrefix: "INV-",
  address: "",
  phone: "",
  gstin: "",
  receiptFooter: "",
  lowStockThresholdMilli: 0,
};

export interface Category {
  id: number;
  name: string;
  /** Marketplace category uuid this local category publishes as; null until mapped. */
  marketplaceCategoryId: string | null;
}

export interface Item {
  id: number;
  name: string;
  barcode: string;
  categoryId: number | null;
  categoryName: string | null;
  unitKind: UnitKind;
  pricePaise: number;
  mrpPaise: number;
  taxRateBp: number;
  stockMilli: number;
  isActive: boolean;
  photoPath: string;
  publishState: string;
  remoteProductId: string | null;
  remoteVariantId: string | null;
  /** Billing-owned content fingerprint of the last successful publish. */
  contentHash: string | null;
  /** Relative photo file name (never an absolute path); "" when none. */
  photoFile: string;
  /** SHA-256 of the photo bytes; null when no photo. */
  imageHash: string | null;
  /** Set once the marketplace confirmed the photo currently attached. */
  imageUploadedAt: string | null;
  /** Fingerprint of price/stock as last observed on the marketplace. */
  remoteHash: string | null;
  hsnCode: string;
  costPricePaise: number;
  updatedAt: string;
}

/** A bill parked at the till; not yet a bill (no number, no stock movement). */
export interface HeldBill {
  id: number;
  label: string;
  customerId: number | null;
  lines: { itemId: number; qtyMilli: number }[];
  createdAt: string;
}

export interface HeldBillInput {
  id?: number;
  label: string;
  customerId: number | null;
  lines: { itemId: number; qtyMilli: number }[];
}

export type OutboxStatus = "pending" | "done";

/** A stock movement waiting for (or already sent to) the marketplace. */
export interface OutboxRow {
  id: number;
  idempotencyKey: string;
  externalId: string;
  deltaUnits: number;
  reason: "sale" | "adjustment" | "order_cancel";
  attempts: number;
  nextAttemptAt: string | null;
  status: OutboxStatus;
}

export interface RemoteOrderLine {
  externalId: string | null;
  productName: string | null;
  qtyUnits: number;
  unitPricePaise: number;
}

/** Read-only mirror of a marketplace order (stock already arrived via the feed). */
export interface RemoteOrderRecord {
  id: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  totalPaise: number;
  placedAt: string;
  updatedAt: string;
  lines: RemoteOrderLine[];
  syncedAt: string;
}

/** Remote catalogue entry observed for an item (reconcile + fingerprinting). */
export interface RemoteItemLink {
  externalId: string;
  stockUnits: number;
  pricePaise: number;
  remoteHash: string;
}

/** Local vs marketplace difference awaiting the seller's decision. */
export interface ReconcileFix {
  itemId: number;
  externalId: string;
  kind: "stock" | "price" | "missing_remote" | "remote_inactive";
  /** What to write on the marketplace side (price change / stock target). */
  pricePaise?: number;
  stockUnits?: number;
  isActive?: boolean;
  /** True when the local row should change instead of the marketplace. */
  pullToLocal?: boolean;
}

/** One item's outcome from a publish run; persisted so the UI can show states. */
export interface PublishOutcome {
  itemId: number;
  /** `local_only` | `queued` | `live` | `hidden` | `pending_store_approval` | `error` */
  state: string;
  remoteProductId: string | null;
  remoteVariantId: string | null;
  /** Hash of the billing-owned content that was successfully published. */
  contentHash: string | null;
}

export interface ItemInput {
  id?: number;
  name: string;
  barcode: string;
  categoryId: number | null;
  unitKind: UnitKind;
  pricePaise: number;
  mrpPaise: number;
  taxRateBp: number;
  /** Applied only when creating a new item. */
  openingStockMilli: number;
  isActive: boolean;
  hsnCode?: string;
  costPricePaise?: number;
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  gstin: string;
  address: string;
  loyaltyPoints: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerInput {
  id?: number;
  name: string;
  phone: string;
  gstin?: string;
  address?: string;
}

export interface CustomerPayment {
  id: number;
  customerId: number;
  amountPaise: number;
  mode: PaymentMode | "bank";
  notes: string;
  createdAt: string;
}

export interface CustomerPaymentInput {
  customerId: number;
  amountPaise: number;
  mode: PaymentMode | "bank";
  notes?: string;
  createdAt?: string;
}

export interface CustomerLedgerEntry {
  id: string;
  type: "credit_bill" | "payment";
  date: string;
  refNumber: string;
  description: string;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number;
}

export interface CustomerLedgerSummary {
  customer: Customer;
  totalCreditBilledPaise: number;
  totalPaidPaise: number;
  outstandingBalancePaise: number;
  entries: CustomerLedgerEntry[];
}

export interface BillSummary {
  id: number;
  number: string;
  fy: string;
  status: "active" | "void";
  customerId: number | null;
  customerName: string | null;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  discountPaise: number;
  roundOffPaise: number;
  notes: string;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface BillLineRow {
  id: number;
  billId: number;
  lineNo: number;
  itemId: number | null;
  nameSnapshot: string;
  qtyMilli: number;
  unitPricePaise: number;
  taxRateBp: number;
  taxPaise: number;
  totalPaise: number;
  discountPaise: number;
  hsnCode: string;
}

export interface PaymentRow {
  id: number;
  billId: number;
  mode: PaymentMode;
  amountPaise: number;
}

export interface BillDetail extends BillSummary {
  lines: BillLineRow[];
  payments: PaymentRow[];
}

export interface StockMovementRecord {
  id: number;
  itemId: number;
  deltaMilli: number;
  reason: MovementReason;
  refType: MovementRefType | null;
  refId: string | null;
  createdAt: string;
}

export interface ImportRowOutcome {
  /** 0-based index into the submitted batch. */
  index: number;
  ok: boolean;
  id?: number;
  error?: string;
}

// --- Phase 2: Daily-Driver types -------------------------------------------

export interface CreditNoteLine {
  id: number;
  creditNoteId: number;
  itemId: number | null;
  nameSnapshot: string;
  qtyMilli: number;
  unitPricePaise: number;
  taxRateBp: number;
  taxPaise: number;
  totalPaise: number;
  hsnCode: string;
}

export interface CreditNote {
  id: number;
  billId: number;
  number: string;
  fy: string;
  reason: string;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  createdAt: string;
  lines: CreditNoteLine[];
}

export interface NewCreditNotePayload {
  billId: number;
  reason: string;
  createdAt: string;
  lines: {
    itemId: number | null;
    nameSnapshot: string;
    qtyMilli: number;
    unitPricePaise: number;
    taxRateBp: number;
    taxPaise: number;
    totalPaise: number;
    hsnCode?: string;
  }[];
}

export interface Supplier {
  id: number;
  name: string;
  phone: string;
  gstin: string;
  address: string;
  createdAt: string;
}

export interface SupplierInput {
  id?: number;
  name: string;
  phone?: string;
  gstin?: string;
  address?: string;
}

export interface PurchaseLine {
  id: number;
  purchaseId: number;
  itemId: number | null;
  nameSnapshot: string;
  qtyMilli: number;
  unitCostPaise: number;
  taxRateBp: number;
  taxPaise: number;
  totalPaise: number;
}

export interface Purchase {
  id: number;
  supplierId: number;
  supplierName?: string;
  invoiceNo: string;
  invoiceDate: string;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  status: string;
  createdAt: string;
  lines: PurchaseLine[];
}

export interface NewPurchasePayload {
  supplierId: number;
  invoiceNo: string;
  invoiceDate: string;
  status?: string;
  createdAt: string;
  lines: {
    itemId: number | null;
    nameSnapshot: string;
    qtyMilli: number;
    unitCostPaise: number;
    taxRateBp: number;
  }[];
}

export type UserRole = "owner" | "cashier";

export interface User {
  id: number;
  name: string;
  role: UserRole;
  pin: string;
  isActive: boolean;
  createdAt: string;
}

export interface UserInput {
  id?: number;
  name: string;
  role: UserRole;
  pin: string;
  isActive?: boolean;
}

export interface AuditLog {
  id: number;
  userId: number | null;
  userName?: string;
  action: string;
  details: string;
  createdAt: string;
}

export interface AuditLogInput {
  userId?: number | null;
  action: string;
  details?: string;
  createdAt?: string;
}

export interface StockDiscrepancyInput {
  itemId: number;
  physicalCountMilli: number;
  reason?: string;
  createdAt?: string;
}

// --- Phase 3: Smart-Merchant Types -----------------------------------------

export interface ItemBatch {
  id: number;
  itemId: number;
  batchNo: string;
  mfgDate: string | null;
  expiryDate: string;
  costPricePaise: number;
  mrpPaise: number;
  stockMilli: number;
  createdAt: string;
}

export interface BatchInput {
  id?: number;
  itemId: number;
  batchNo: string;
  mfgDate?: string | null;
  expiryDate: string;
  costPricePaise: number;
  mrpPaise: number;
  stockMilli: number;
  createdAt?: string;
}

export interface LoyaltyTransaction {
  id: number;
  customerId: number;
  billId: number | null;
  pointsDelta: number;
  reason: string;
  createdAt: string;
}

export interface ItemBarcode {
  id: number;
  itemId: number;
  barcode: string;
  packQtyMilli: number;
  label: string;
}

export interface BarcodeLookupResult {
  itemId: number;
  itemName: string;
  barcode: string;
  packQtyMilli: number;
  pricePaise: number;
}

export interface DayEndClosure {
  id: number;
  closureDate: string;
  userId: number | null;
  userName?: string;
  openingCashPaise: number;
  cashSalesPaise: number;
  creditReceivedPaise: number;
  cashRefundsPaise: number;
  expectedCashPaise: number;
  actualCashPaise: number;
  variancePaise: number;
  totalBillsCount: number;
  totalSalesPaise: number;
  notes: string;
  createdAt: string;
}

export interface DayEndClosureInput {
  closureDate: string;
  userId?: number | null;
  openingCashPaise: number;
  cashSalesPaise: number;
  creditReceivedPaise: number;
  cashRefundsPaise: number;
  expectedCashPaise: number;
  actualCashPaise: number;
  variancePaise: number;
  totalBillsCount: number;
  totalSalesPaise: number;
  notes?: string;
  createdAt?: string;
}

export interface DayEndExpectedCash {
  cashSalesPaise: number;
  creditReceivedPaise: number;
  cashRefundsPaise: number;
  totalBillsCount: number;
  totalSalesPaise: number;
}
