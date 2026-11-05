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
  UnitKind,
} from "@mytowncart-billing/core";
import type {
  BillDetail,
  BillSummary,
  Category,
  Customer,
  HeldBill,
  HeldBillInput,
  ImportRowOutcome,
  Item,
  ItemInput,
  OutboxRow,
  PublishOutcome,
  ReconcileFix,
  RemoteItemLink,
  RemoteOrderRecord,
  ShopProfile,
  StockMovementRecord,
} from "./types";

/** Fully-computed new bill, as produced by core's `computeBill` + the UI. */
export interface NewBillPayload {
  fy: string;
  prefix: string;
  customerId: number | null;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  createdAt: string;
  lines: {
    itemId: number;
    nameSnapshot: string;
    qtyMilli: number;
    unitPricePaise: number;
    taxRateBp: number;
    taxPaise: number;
    totalPaise: number;
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
  readonly kind: "tauri" | "memory";

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
  /** Acknowledge uploaded photos (matched by hash; stale acks are ignored). */
  recordImageUploads(
    uploads: readonly { itemId: number; imageHash: string; uploadedAt: string }[],
  ): Promise<void>;

  listCustomers(search?: string): Promise<Customer[]>;
  upsertCustomer(input: { id?: number; name: string; phone: string }): Promise<number>;

  /** Allocates the invoice number and persists bill+lines+payments+stock atomically. */
  createBill(bill: NewBillPayload): Promise<CreatedBill>;
  voidBill(billId: number, reason: string): Promise<void>;
  listBills(filter?: BillFilter): Promise<BillSummary[]>;
  getBill(id: number): Promise<BillDetail | null>;

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
  listRemoteOrders(): Promise<RemoteOrderRecord[]>;
  recordRemoteOrders(orders: readonly RemoteOrderRecord[]): Promise<number>;
  /** Reconcile with "local wins": write local price/stock into the marketplace. */
  applyReconcileFixes(fixes: readonly ReconcileFix[]): Promise<void>;

  // --- generic JSON documents (backup/pilot settings) -----------------------

  getAppSetting(key: string): Promise<string | null>;
  setAppSetting(key: string, value: string | null): Promise<void>;
}

export type { UnitKind };
