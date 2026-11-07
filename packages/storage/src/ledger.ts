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
