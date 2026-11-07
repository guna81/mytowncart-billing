// SPDX-License-Identifier: Apache-2.0
/**
 * Bill computation (roadmap §8.2). Bills are IMMUTABLE: this module only
 * computes a new bill from line inputs; there is deliberately no edit
 * function. Mistakes are fixed with void-with-reason (see `validateVoidReason`).
 */

import { allocatePaise, roundDiv } from "./money";
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
  /** Line-level discount in paise. */
  discountPaise?: number;
  /** HSN/SAC code snapshot. */
  hsnCode?: string;
}

export interface ComputedBillLine extends LineAmounts {
  itemId: number;
  name: string;
  qtyMilli: number;
  unitPricePaise: number;
  taxRateBp: number;
  unitKind?: UnitKind;
  hsnCode: string;
}

export interface ComputedBill {
  lines: ComputedBillLine[];
  /** Sum of line nets (taxable value). */
  subtotalPaise: number;
  /** Sum of line taxes. */
  taxPaise: number;
  /** Sum of line totals before round-off. */
  unroundedTotalPaise: number;
  /** Round-off adjustment in paise (to nearest whole rupee). */
  roundOffPaise: number;
  /** Total after round-off = what the customer pays. */
  totalPaise: number;
  /** Total discount across all lines + bill discount. */
  discountPaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

export interface ComputeBillOpts {
  pricesIncludeTax: boolean;
  /** Bill-level discount in paise; spread proportionally across lines. */
  billDiscountPaise?: number;
  /** Round total to nearest whole rupee (0 paise). Default true. */
  roundOff?: boolean;
}

export function computeBill(
  lines: BillLineInput[],
  opts: ComputeBillOpts,
): ComputedBill {
  const billDiscount = Math.max(0, opts.billDiscountPaise ?? 0);
  const roundOffEnabled = opts.roundOff ?? false;

  // 1. Initial line computation with line discounts only
  const initialLines = lines.map((line) => {
    const amounts = computeLineAmounts({
      qtyMilli: line.qtyMilli,
      unitPricePaise: line.unitPricePaise,
      taxRateBp: line.taxRateBp,
      pricesIncludeTax: opts.pricesIncludeTax,
      discountPaise: line.discountPaise ?? 0,
    });
    return {
      line,
      amounts,
    };
  });

  // 2. If bill-level discount is provided, spread it proportionally across lines
  let finalDiscounts = initialLines.map((l) => l.line.discountPaise ?? 0);
  if (billDiscount > 0 && initialLines.length > 0) {
    const weights = initialLines.map((l) => l.amounts.totalPaise);
    const weightSum = weights.reduce((s, w) => s + w, 0);
    if (weightSum > 0) {
      const billDiscountShares = allocatePaise(Math.min(billDiscount, weightSum), weights);
      // Shares are amounts off what the customer pays (tax-inclusive). When prices
      // exclude tax the line discount is taken off the net, so scale the share
      // back by (1 + rate) — otherwise a Rs 100 discount at 18% GST would take
      // Rs 118 off the total.
      finalDiscounts = finalDiscounts.map((d, i) => {
        const share = billDiscountShares[i] ?? 0;
        const bp = initialLines[i]!.line.taxRateBp;
        const netShare = opts.pricesIncludeTax || bp === 0 ? share : roundDiv(share * 10_000, 10_000 + bp);
        return d + netShare;
      });

      // Per-line rounding can leave the total a paise or two away from
      // "before-discount total minus the discount". Nudge single lines (largest
      // first) by one paisa at a time until the payable total is exact.
      const wanted = weightSum - Math.min(billDiscount, weightSum);
      const lineTotal = (i: number, d: number) =>
        computeLineAmounts({
          qtyMilli: lines[i]!.qtyMilli,
          unitPricePaise: lines[i]!.unitPricePaise,
          taxRateBp: lines[i]!.taxRateBp,
          pricesIncludeTax: opts.pricesIncludeTax,
          discountPaise: d,
        }).totalPaise;
      const totals = finalDiscounts.map((d, i) => lineTotal(i, d));
      let off = totals.reduce((a, b) => a + b, 0) - wanted;
      const order = weights.map((_, i) => i).sort((a, b) => weights[b]! - weights[a]!);
      for (let guard = 0; off !== 0 && guard < 50; guard++) {
        let moved = false;
        for (const i of order) {
          const step = off > 0 ? 1 : -1; // more discount lowers the total
          const d = finalDiscounts[i]! + step;
          if (d < (lines[i]!.discountPaise ?? 0)) continue;
          const t = lineTotal(i, d);
          const next = off - totals[i]! + t;
          if (t >= 0 && Math.abs(next) < Math.abs(off)) {
            finalDiscounts[i] = d;
            totals[i] = t;
            off = next;
            moved = true;
            break;
          }
        }
        if (!moved) break;
      }
    }
  }

  // 3. Compute final line amounts with combined discounts
  const computed: ComputedBillLine[] = lines.map((line, i) => {
    const amounts = computeLineAmounts({
      qtyMilli: line.qtyMilli,
      unitPricePaise: line.unitPricePaise,
      taxRateBp: line.taxRateBp,
      pricesIncludeTax: opts.pricesIncludeTax,
      discountPaise: finalDiscounts[i],
    });
    return {
      itemId: line.itemId,
      name: line.name,
      qtyMilli: line.qtyMilli,
      unitPricePaise: line.unitPricePaise,
      taxRateBp: line.taxRateBp,
      unitKind: line.unitKind,
      hsnCode: line.hsnCode ?? "",
      ...amounts,
    };
  });

  const sum = (pick: (l: ComputedBillLine) => number) =>
    computed.reduce((s, l) => s + pick(l), 0);

  const subtotalPaise = sum((l) => l.netPaise);
  const taxPaise = sum((l) => l.taxPaise);
  const unroundedTotalPaise = sum((l) => l.totalPaise);
  const discountPaise = sum((l) => l.discountPaise);

  let roundOffPaise = 0;
  let totalPaise = unroundedTotalPaise;

  if (roundOffEnabled && unroundedTotalPaise > 0) {
    // Nearest rupee: round(paise / 100) * 100
    const rounded = roundDiv(unroundedTotalPaise, 100) * 100;
    roundOffPaise = rounded - unroundedTotalPaise;
    totalPaise = rounded;
  }

  return {
    lines: computed,
    subtotalPaise,
    taxPaise,
    unroundedTotalPaise,
    roundOffPaise,
    totalPaise,
    discountPaise,
    cgstPaise: sum((l) => l.cgstPaise),
    sgstPaise: sum((l) => l.sgstPaise),
  };
}

export interface PaymentInput {
  mode: PaymentMode;
  amountPaise: number;
}

export interface ValidateBillOpts {
  customerId?: number | null;
}

/**
 * Validate a computed bill + its payments before saving. Returns a list of
 * machine-readable error codes ("" none). Rules:
 *  - at least one line; every line qty > 0, price >= 0; count items whole units
 *  - at least one payment; amounts > 0; known modes
 *  - payments sum to >= total; overpayment (change) is allowed only when a
 *    `cash` payment is present (you cannot overpay on UPI/card)
 *  - credit sales require an attached customer
 */
export function validateBill(
  bill: ComputedBill,
  payments: PaymentInput[],
  opts?: ValidateBillOpts,
): string[] {
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
  let hasCredit = false;
  const paid = payments.reduce((s, p) => {
    if (!isPaymentMode(p.mode)) errors.push("payment.unknown_mode");
    if (p.amountPaise <= 0) errors.push("payment.amount_not_positive");
    if (p.mode === "credit") hasCredit = true;
    return s + p.amountPaise;
  }, 0);
  if (paid < bill.totalPaise) errors.push("payment.insufficient");
  if (paid > bill.totalPaise) {
    // Change is handed back in cash, so it can never exceed the cash tendered.
    const cash = payments.filter((p) => p.mode === "cash").reduce((s, p) => s + p.amountPaise, 0);
    if (cash === 0) errors.push("payment.overpay_requires_cash");
    else if (paid - bill.totalPaise > cash) errors.push("payment.change_exceeds_cash");
  }
  if (hasCredit && (opts?.customerId === undefined || opts?.customerId === null)) {
    errors.push("payment.credit_requires_customer");
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
