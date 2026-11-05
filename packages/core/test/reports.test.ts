// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  aggregateDailySales,
  aggregateSalesByItem,
  aggregateSalesByPaymentMode,
  type ReportBill,
} from "../src/reports";

const bill = (over: Partial<ReportBill>): ReportBill => ({
  id: 1,
  number: "INV-0001",
  status: "active",
  createdAt: "2026-11-04T10:00:00",
  subtotalPaise: 1000,
  taxPaise: 50,
  totalPaise: 1050,
  lines: [],
  payments: [],
  ...over,
});

describe("aggregateDailySales", () => {
  it("groups by calendar date and sorts ascending", () => {
    const rows = aggregateDailySales([
      bill({ id: 2, createdAt: "2026-11-05T09:00:00", totalPaise: 500, subtotalPaise: 480, taxPaise: 20 }),
      bill({ id: 1, createdAt: "2026-11-04T10:00:00" }),
      bill({ id: 3, createdAt: "2026-11-04T18:30:00", totalPaise: 100, subtotalPaise: 100, taxPaise: 0 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      date: "2026-11-04",
      billCount: 2,
      subtotalPaise: 1100,
      taxPaise: 50,
      totalPaise: 1150,
    });
    expect(rows[1]!.date).toBe("2026-11-05");
  });

  it("excludes void bills", () => {
    const rows = aggregateDailySales([bill({}), bill({ id: 2, status: "void", totalPaise: 999 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalPaise).toBe(1050);
  });

  it("handles no bills", () => {
    expect(aggregateDailySales([])).toEqual([]);
  });
});

describe("aggregateSalesByItem", () => {
  it("sums qty and revenue per item, sorted by revenue desc", () => {
    const rows = aggregateSalesByItem([
      bill({
        lines: [
          { itemId: 1, nameSnapshot: "A", qtyMilli: 1000, totalPaise: 100, taxPaise: 0 },
          { itemId: 2, nameSnapshot: "B", qtyMilli: 500, totalPaise: 400, taxPaise: 0 },
        ],
      }),
      bill({
        id: 2,
        lines: [{ itemId: 1, nameSnapshot: "A", qtyMilli: 2000, totalPaise: 200, taxPaise: 0 }],
      }),
    ]);
    expect(rows).toEqual([
      { itemId: 2, name: "B", qtyMilli: 500, totalPaise: 400 },
      { itemId: 1, name: "A", qtyMilli: 3000, totalPaise: 300 },
    ]);
  });

  it("groups deleted items (null id) by name snapshot", () => {
    const rows = aggregateSalesByItem([
      bill({
        lines: [{ itemId: null, nameSnapshot: "Old item", qtyMilli: 1000, totalPaise: 50, taxPaise: 0 }],
      }),
      bill({
        id: 2,
        lines: [{ itemId: null, nameSnapshot: "Old item", qtyMilli: 1000, totalPaise: 50, taxPaise: 0 }],
      }),
    ]);
    expect(rows).toEqual([{ itemId: null, name: "Old item", qtyMilli: 2000, totalPaise: 100 }]);
  });

  it("excludes lines of void bills", () => {
    const rows = aggregateSalesByItem([
      bill({ status: "void", lines: [{ itemId: 1, nameSnapshot: "A", qtyMilli: 1000, totalPaise: 100, taxPaise: 0 }] }),
    ]);
    expect(rows).toEqual([]);
  });
});

describe("aggregateSalesByPaymentMode", () => {
  it("sums amounts per mode across bills", () => {
    const rows = aggregateSalesByPaymentMode([
      bill({ payments: [{ mode: "cash", amountPaise: 1000 }, { mode: "upi", amountPaise: 50 }] }),
      bill({ id: 2, payments: [{ mode: "cash", amountPaise: 200 }] }),
    ]);
    expect(rows).toEqual([
      { mode: "cash", amountPaise: 1200 },
      { mode: "upi", amountPaise: 50 },
    ]);
  });

  it("excludes void bills", () => {
    expect(
      aggregateSalesByPaymentMode([
        bill({ status: "void", payments: [{ mode: "cash", amountPaise: 1000 }] }),
      ]),
    ).toEqual([]);
  });
});
