// SPDX-License-Identifier: Apache-2.0
/**
 * Stock ledger (roadmap §8.2): stock is a ledger of `stock_movements`;
 * `items.stock_milli` is only a cached sum updated in the same transaction.
 * This module turns domain events (sale, void, adjustment, opening stock)
 * into movement descriptors and folds movement streams into a stock level.
 */

export type MovementReason =
  | "opening"
  | "sale"
  | "void"
  | "adjustment"
  | "purchase"
  | "import"
  | "online_order"
  | "order_cancel";

export type MovementRefType = "bill" | "adjustment" | "import" | "sync";

export interface MovementDescriptor {
  itemId: number;
  /** Signed change in milli-units (negative = stock leaves). */
  deltaMilli: number;
  reason: MovementReason;
  refType: MovementRefType | null;
  /** Filled by the storage layer when the ref id only exists after insert (e.g. bill id). */
  refId?: string | null;
}

export interface StockMovementRow extends MovementDescriptor {
  id: number;
  refId: string | null;
  createdAt: string;
}

/** Opening stock for a newly created item; null when there is nothing to record. */
export function openingStockMovement(itemId: number, qtyMilli: number): MovementDescriptor | null {
  if (qtyMilli === 0) return null;
  return { itemId, deltaMilli: qtyMilli, reason: "opening", refType: null, refId: null };
}

/** Sale: one negative movement per bill line. `refId` (the bill id) is set by storage. */
export function saleMovements(
  lines: readonly { itemId: number; qtyMilli: number }[],
): MovementDescriptor[] {
  return lines.map((l) => ({
    itemId: l.itemId,
    deltaMilli: -l.qtyMilli,
    reason: "sale",
    refType: "bill",
    refId: null,
  }));
}

/** Void: exact inverse of the sale movements (positive deltas restore stock). */
export function voidCompensationMovements(
  lines: readonly { itemId: number; qtyMilli: number }[],
): MovementDescriptor[] {
  return lines.map((l) => ({
    itemId: l.itemId,
    deltaMilli: l.qtyMilli,
    reason: "void",
    refType: "bill",
    refId: null,
  }));
}

/** Manual stock adjustment (count correction, damage, purchase entry, ...). */
export function adjustmentMovement(
  itemId: number,
  deltaMilli: number,
  reason: MovementReason = "adjustment",
): MovementDescriptor {
  if (deltaMilli === 0) throw new Error("an adjustment must change the stock");
  return { itemId, deltaMilli, reason, refType: "adjustment", refId: null };
}

/** Fold a movement stream into a stock level (the ledger's ground truth). */
export function applyMovements(
  initialMilli: number,
  deltasMilli: readonly number[],
): number {
  return deltasMilli.reduce((stock, d) => stock + d, initialMilli);
}

/** Low-stock predicate used by the Items and Stock screens. */
export function isLowStock(stockMilli: number, thresholdMilli: number): boolean {
  return stockMilli <= thresholdMilli;
}
