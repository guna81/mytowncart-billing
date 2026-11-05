// SPDX-License-Identifier: Apache-2.0
/**
 * Reports (roadmap §8.8): daily sales, sales by item, sales by payment
 * mode. Pure aggregations over bill detail rows; VOID bills are excluded
 * everywhere (a voided bill never happened, commercially).
 */

import type { PaymentMode } from "./bill";

export interface ReportBillLine {
  itemId: number | null;
  nameSnapshot: string;
  qtyMilli: number;
  totalPaise: number;
  taxPaise: number;
}

export interface ReportBill {
  id: number;
  number: string;
  status: "active" | "void";
  /** ISO timestamp; daily grouping uses its first 10 chars (local date as stored). */
  createdAt: string;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  lines: ReportBillLine[];
  payments: { mode: PaymentMode; amountPaise: number }[];
}

function activeBills(bills: readonly ReportBill[]): ReportBill[] {
  return bills.filter((b) => b.status === "active");
}

export interface DailySalesRow {
  date: string;
  billCount: number;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
}

export function aggregateDailySales(bills: readonly ReportBill[]): DailySalesRow[] {
  const byDate = new Map<string, DailySalesRow>();
  for (const b of activeBills(bills)) {
    const date = b.createdAt.slice(0, 10);
    const row = byDate.get(date) ?? { date, billCount: 0, subtotalPaise: 0, taxPaise: 0, totalPaise: 0 };
    row.billCount += 1;
    row.subtotalPaise += b.subtotalPaise;
    row.taxPaise += b.taxPaise;
    row.totalPaise += b.totalPaise;
    byDate.set(date, row);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface ItemSalesRow {
  itemId: number | null;
  name: string;
  qtyMilli: number;
  totalPaise: number;
}

export function aggregateSalesByItem(bills: readonly ReportBill[]): ItemSalesRow[] {
  const byItem = new Map<string, ItemSalesRow>();
  for (const b of activeBills(bills)) {
    for (const l of b.lines) {
      const key = l.itemId === null ? `name:${l.nameSnapshot}` : `id:${l.itemId}`;
      const row =
        byItem.get(key) ??
        { itemId: l.itemId, name: l.nameSnapshot, qtyMilli: 0, totalPaise: 0 };
      row.qtyMilli += l.qtyMilli;
      row.totalPaise += l.totalPaise;
      byItem.set(key, row);
    }
  }
  return [...byItem.values()].sort((a, b) => b.totalPaise - a.totalPaise);
}

export interface PaymentModeSalesRow {
  mode: PaymentMode;
  amountPaise: number;
}

export function aggregateSalesByPaymentMode(
  bills: readonly ReportBill[],
): PaymentModeSalesRow[] {
  const byMode = new Map<PaymentMode, number>();
  for (const b of activeBills(bills)) {
    for (const p of b.payments) {
      byMode.set(p.mode, (byMode.get(p.mode) ?? 0) + p.amountPaise);
    }
  }
  return [...byMode.entries()]
    .map(([mode, amountPaise]) => ({ mode, amountPaise }))
    .sort((a, b) => b.amountPaise - a.amountPaise);
}
