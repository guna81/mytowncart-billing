// SPDX-License-Identifier: Apache-2.0
/**
 * Bill computation (roadmap §8.2). Bills are IMMUTABLE: this module only
 * computes a new bill from line inputs; there is deliberately no edit
 * function. Mistakes are fixed with void-with-reason (see `validateVoidReason`).
 */

import { isWholeCount, type UnitKind } from "./quantity";
import { computeLineAmounts, type LineAmounts } from "./tax";

export type PaymentMode = "cash" | "upi" | "card" | "credit";

export const PAYMENT_MODES: readonly PaymentMode[] = ["cash", "upi", "card", "credit"];

export function isPaymentMode(value: string): value is PaymentMode {
  return (PAYMENT_MODES as readonly string[]).includes(value);
}

export type BillStatus = "active" | "void";

export interface BillLineInput {
  itemId: number;
  /** Snapshot of the item name at sale time (the bill must not depend on later edits). */
  name: string;
  qtyMilli: number;
  unitPricePaise: number;
  taxRateBp: number;
  /** `count` items must have whole-unit quantities. */
  unitKind?: UnitKind;
}

export interface ComputedBillLine extends LineAmounts {
  itemId: number;
  name: string;
  qtyMilli: number;
  unitPricePaise: number;
  taxRateBp: number;
  unitKind?: UnitKind;
}

export interface ComputedBill {
  lines: ComputedBillLine[];
  /** Sum of line nets (before tax). */
  subtotalPaise: number;
  /** Sum of line taxes. */
  taxPaise: number;
  /** Sum of line totals = what the customer pays. */
  totalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

export function computeBill(
  lines: BillLineInput[],
  opts: { pricesIncludeTax: boolean },
): ComputedBill {
  const computed = lines.map((line): ComputedBillLine => {
    const amounts = computeLineAmounts({
      qtyMilli: line.qtyMilli,
      unitPricePaise: line.unitPricePaise,
      taxRateBp: line.taxRateBp,
      pricesIncludeTax: opts.pricesIncludeTax,
    });
    return {
      itemId: line.itemId,
      name: line.name,
      qtyMilli: line.qtyMilli,
      unitPricePaise: line.unitPricePaise,
      taxRateBp: line.taxRateBp,
      unitKind: line.unitKind,
      ...amounts,
    };
  });
  const sum = (pick: (l: ComputedBillLine) => number) =>
    computed.reduce((s, l) => s + pick(l), 0);
  return {
    lines: computed,
    subtotalPaise: sum((l) => l.netPaise),
    taxPaise: sum((l) => l.taxPaise),
    totalPaise: sum((l) => l.totalPaise),
    cgstPaise: sum((l) => l.cgstPaise),
    sgstPaise: sum((l) => l.sgstPaise),
  };
}

export interface PaymentInput {
  mode: PaymentMode;
  amountPaise: number;
}

/**
 * Validate a computed bill + its payments before saving. Returns a list of
 * machine-readable error codes ("" none). Rules:
 *  - at least one line; every line qty > 0, price >= 0; count items whole units
 *  - at least one payment; amounts > 0; known modes
 *  - payments sum to >= total; overpayment (change) is allowed only when a
 *    `cash` payment is present (you cannot overpay on UPI/card)
 */
export function validateBill(bill: ComputedBill, payments: PaymentInput[]): string[] {
  const errors: string[] = [];
  if (bill.lines.length === 0) errors.push("bill.no_lines");
  for (const line of bill.lines) {
    if (line.qtyMilli <= 0) errors.push("line.qty_not_positive");
    if (line.unitPricePaise < 0) errors.push("line.negative_price");
    if (line.unitKind === "count" && !isWholeCount(line.qtyMilli)) {
      errors.push("line.count_qty_not_whole");
    }
  }
  if (payments.length === 0) errors.push("bill.no_payments");
  const paid = payments.reduce((s, p) => {
    if (!isPaymentMode(p.mode)) errors.push("payment.unknown_mode");
    if (p.amountPaise <= 0) errors.push("payment.amount_not_positive");
    return s + p.amountPaise;
  }, 0);
  if (paid < bill.totalPaise) errors.push("payment.insufficient");
  if (paid > bill.totalPaise && !payments.some((p) => p.mode === "cash")) {
    errors.push("payment.overpay_requires_cash");
  }
  return [...new Set(errors)];
}

/** Change due when payments exceed the total (only possible with cash, see validateBill). */
export function computeChangePaise(bill: ComputedBill, payments: PaymentInput[]): number {
  const paid = payments.reduce((s, p) => s + p.amountPaise, 0);
  return Math.max(0, paid - bill.totalPaise);
}

/** A void must carry a human reason (roadmap §8.2: "void-with-reason"). */
export function validateVoidReason(reason: string): string | null {
  return reason.trim().length === 0 ? "void.reason_required" : null;
}
