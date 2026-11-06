// SPDX-License-Identifier: Apache-2.0

/**
 * Pure domain logic for Cash Drawer Reconciliation and Day-End (Z-Report) closing.
 */

export interface DenominationCounts {
  n2000?: number;
  n500?: number;
  n200?: number;
  n100?: number;
  n50?: number;
  n20?: number;
  n10?: number;
  n5?: number;
  coins?: number; // total value of loose coins in rupees
}

/**
 * Computes the total cash in paise from individual currency denomination counts.
 */
export function computeDenominationsTotalPaise(counts: DenominationCounts): number {
  let totalPaise = 0;
  if (counts.n2000) totalPaise += counts.n2000 * 2000 * 100;
  if (counts.n500) totalPaise += counts.n500 * 500 * 100;
  if (counts.n200) totalPaise += counts.n200 * 200 * 100;
  if (counts.n100) totalPaise += counts.n100 * 100 * 100;
  if (counts.n50) totalPaise += counts.n50 * 50 * 100;
  if (counts.n20) totalPaise += counts.n20 * 20 * 100;
  if (counts.n10) totalPaise += counts.n10 * 10 * 100;
  if (counts.n5) totalPaise += counts.n5 * 5 * 100;
  if (counts.coins) totalPaise += Math.round(counts.coins * 100);
  return totalPaise;
}

/**
 * Calculate expected cash in drawer at closing:
 * Expected = Opening Cash + Cash Sales + Customer Cash Receipts - Cash Refunds
 */
export function computeExpectedDrawerCash(
  openingCashPaise: number,
  cashSalesPaise: number,
  customerCashReceiptsPaise: number,
  cashRefundsPaise: number,
): number {
  return Math.max(0, openingCashPaise + cashSalesPaise + customerCashReceiptsPaise - cashRefundsPaise);
}

/**
 * Computes the cash variance between physical count and expected cash.
 * Zero = balanced; Positive = cash over; Negative = cash short.
 */
export function computeCashVariance(actualCashPaise: number, expectedCashPaise: number): number {
  return actualCashPaise - expectedCashPaise;
}
