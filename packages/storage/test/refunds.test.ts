// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { creditNoteCashRefunds } from "../src/ledger";

const note = (id: number, billId: number, totalPaise: number) => ({ id, billId, createdAt: "x", totalPaise });

describe("creditNoteCashRefunds", () => {
  it("moves no cash for UPI or credit sales", () => {
    const bills = [
      { id: 1, totalPaise: 20_000, payments: [{ mode: "upi", amountPaise: 20_000 }] },
      { id: 2, totalPaise: 30_000, payments: [{ mode: "credit", amountPaise: 30_000 }] },
    ];
    const r = creditNoteCashRefunds(bills, [note(1, 1, 5_000), note(2, 2, 10_000)]);
    expect(r.get(1)).toBe(0);
    expect(r.get(2)).toBe(0);
  });

  it("refunds cash in proportion to how the bill was paid", () => {
    const bills = [
      {
        id: 1,
        totalPaise: 40_000,
        payments: [
          { mode: "cash", amountPaise: 20_000 },
          { mode: "upi", amountPaise: 20_000 },
        ],
      },
    ];
    expect(creditNoteCashRefunds(bills, [note(1, 1, 10_000)]).get(1)).toBe(5_000);
  });

  it("clears the customer's debt first and refunds only the excess in cash", () => {
    const bills = [
      {
        id: 1,
        totalPaise: 30_000,
        payments: [
          { mode: "cash", amountPaise: 10_000 },
          { mode: "credit", amountPaise: 20_000 },
        ],
      },
    ];
    expect(creditNoteCashRefunds(bills, [note(1, 1, 25_000)]).get(1)).toBe(5_000);
  });

  it("ignores change on older bills that stored the cash tendered", () => {
    const bills = [{ id: 1, totalPaise: 38_000, payments: [{ mode: "cash", amountPaise: 50_000 }] }];
    expect(creditNoteCashRefunds(bills, [note(1, 1, 8_000)]).get(1)).toBe(8_000);
  });
});
