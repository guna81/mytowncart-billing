// SPDX-License-Identifier: Apache-2.0
/**
 * Customer ledger — one implementation shared by every adapter so the SQLite
 * and in-memory repositories can never disagree about what a customer owes.
 *
 * Owed = credit sold on active bills − payments received − credit-note value
 * applied to credit bills. A credit note only reduces the credit portion of its
 * own bill (any remainder was paid in cash/UPI/card and is refunded outside the
 * ledger), and never by more than that bill's credit is still outstanding.
 */

import type { Customer, CustomerLedgerEntry, CustomerLedgerSummary, CustomerPayment } from "./types";

export interface LedgerBill {
  id: number;
  number: string;
  createdAt: string;
  /** Sum of the bill's `credit` payments. */
  creditPaise: number;
}

export interface LedgerCreditNote {
  id: number;
  number: string;
  billId: number;
  createdAt: string;
  totalPaise: number;
}

export function buildCustomerLedger(
  customer: Customer,
  bills: LedgerBill[],
  payments: CustomerPayment[],
  creditNotes: LedgerCreditNote[],
): CustomerLedgerSummary {
  const entries: CustomerLedgerEntry[] = [];
  let totalCreditBilled = 0;
  const creditByBill = new Map<number, number>();

  for (const b of bills) {
    if (b.creditPaise <= 0) continue;
    totalCreditBilled += b.creditPaise;
    creditByBill.set(b.id, b.creditPaise);
    entries.push({
      id: `bill-${b.id}`,
      type: "credit_bill",
      date: b.createdAt,
      refNumber: b.number,
      description: `Credit bill ${b.number}`,
      debitPaise: b.creditPaise,
      creditPaise: 0,
      balancePaise: 0,
    });
  }

  let totalPaid = 0;
  for (const p of payments) {
    totalPaid += p.amountPaise;
    entries.push({
      id: `pay-${p.id}`,
      type: "payment",
      date: p.createdAt,
      refNumber: `REC-${p.id}`,
      description: `Payment received (${p.mode.toUpperCase()})${p.notes ? ` - ${p.notes}` : ""}`,
      debitPaise: 0,
      creditPaise: p.amountPaise,
      balancePaise: 0,
    });
  }

  const remaining = new Map(creditByBill);
  for (const n of [...creditNotes].sort((a, b) => a.id - b.id)) {
    const left = remaining.get(n.billId);
    if (left === undefined || left <= 0) continue;
    const applied = Math.min(left, n.totalPaise);
    if (applied <= 0) continue;
    remaining.set(n.billId, left - applied);
    totalPaid += applied;
    entries.push({
      id: `cn-${n.id}`,
      type: "credit_note",
      date: n.createdAt,
      refNumber: n.number,
      description: `Credit note ${n.number}`,
      debitPaise: 0,
      creditPaise: applied,
      balancePaise: 0,
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  let running = 0;
  for (const e of entries) {
    running += e.debitPaise - e.creditPaise;
    e.balancePaise = running;
  }

  return {
    customer,
    totalCreditBilledPaise: totalCreditBilled,
    totalPaidPaise: totalPaid,
    outstandingBalancePaise: totalCreditBilled - totalPaid,
    entries,
  };
}

export interface RefundBill {
  id: number;
  totalPaise: number;
  /** Payments as stored. */
  payments: { mode: string; amountPaise: number }[];
}

export interface RefundNote {
  id: number;
  billId: number;
  createdAt: string;
  totalPaise: number;
}

/**
 * Cash that left the drawer for each credit note (by note id). A note is settled
 * first against what the customer still owes on that bill (no cash moves); the
 * rest goes back in proportion to what was paid in cash versus UPI/card.
 * Mirrors `cash_refunds_for_day` in the desktop shell.
 */
export function creditNoteCashRefunds(bills: RefundBill[], notes: RefundNote[]): Map<number, number> {
  const byId = new Map(bills.map((b) => [b.id, b]));
  const creditLeft = new Map<number, number>();
  const out = new Map<number, number>();
  for (const n of [...notes].sort((a, b) => a.billId - b.billId || a.id - b.id)) {
    const bill = byId.get(n.billId);
    if (!bill) continue;
    const sum = (pred: (m: string) => boolean) =>
      bill.payments.filter((p) => pred(p.mode)).reduce((s, p) => s + p.amountPaise, 0);
    const credit = sum((m) => m === "credit");
    const left = creditLeft.get(n.billId) ?? credit;
    const applied = Math.max(0, Math.min(left, n.totalPaise));
    creditLeft.set(n.billId, left - applied);
    const paid = sum(() => true);
    const change = Math.max(0, paid - bill.totalPaise);
    const cashKept = Math.max(0, sum((m) => m === "cash") - change);
    const nonCredit = paid - credit - change;
    const rest = n.totalPaise - applied;
    out.set(n.id, nonCredit > 0 ? Math.floor((rest * cashKept * 2 + nonCredit) / (2 * nonCredit)) : 0);
  }
  return out;
}
