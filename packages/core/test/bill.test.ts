// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  computeBill,
  computeChangePaise,
  isPaymentMode,
  validateBill,
  validateVoidReason,
  type BillLineInput,
} from "../src/bill";

const line = (over: Partial<BillLineInput> = {}): BillLineInput => ({
  itemId: 1,
  name: "Parle-G 100g",
  qtyMilli: 1000,
  unitPricePaise: 1000,
  taxRateBp: 500,
  unitKind: "count",
  ...over,
});

describe("computeBill", () => {
  it("sums line amounts into bill totals (tax-exclusive)", () => {
    const bill = computeBill(
      [line(), line({ itemId: 2, name: "Rice 1kg", qtyMilli: 2000, unitPricePaise: 5550, taxRateBp: 0, unitKind: "count" })],
      { pricesIncludeTax: false },
    );
    expect(bill.lines).toHaveLength(2);
    // line 1: net 1000, tax 50, total 1050
    // line 2: net 11100, tax 0, total 11100
    expect(bill.subtotalPaise).toBe(12_100);
    expect(bill.taxPaise).toBe(50);
    expect(bill.totalPaise).toBe(12_150);
    expect(bill.cgstPaise + bill.sgstPaise).toBe(bill.taxPaise);
  });

  it("bill total always equals the sum of line totals (line-level rounding rule)", () => {
    // Crafted so per-line rounding matters: three 1-paise-half cases.
    const bill = computeBill(
      [
        line({ qtyMilli: 500, unitPricePaise: 3, unitKind: "weight" }),
        line({ itemId: 2, qtyMilli: 500, unitPricePaise: 3, unitKind: "weight" }),
        line({ itemId: 3, qtyMilli: 500, unitPricePaise: 3, unitKind: "weight" }),
      ],
      { pricesIncludeTax: false },
    );
    const lineSum = bill.lines.reduce((s, l) => s + l.totalPaise, 0);
    expect(bill.totalPaise).toBe(lineSum);
    expect(bill.subtotalPaise + bill.taxPaise).toBe(bill.totalPaise);
  });

  it("tax-inclusive shop: total equals qty × sticker price", () => {
    const bill = computeBill([line({ qtyMilli: 3000, unitPricePaise: 1000, taxRateBp: 500 })], {
      pricesIncludeTax: true,
    });
    expect(bill.totalPaise).toBe(3000);
    expect(bill.taxPaise).toBe(143);
    expect(bill.subtotalPaise).toBe(2857);
  });

  it("handles an empty bill", () => {
    const bill = computeBill([], { pricesIncludeTax: true });
    expect(bill.totalPaise).toBe(0);
    expect(bill.lines).toHaveLength(0);
  });
});

describe("validateBill", () => {
  it("accepts a normal cash bill", () => {
    const bill = computeBill([line()], { pricesIncludeTax: false });
    expect(validateBill(bill, [{ mode: "cash", amountPaise: bill.totalPaise }])).toEqual([]);
  });

  it("requires at least one line", () => {
    const bill = computeBill([], { pricesIncludeTax: false });
    expect(validateBill(bill, [{ mode: "cash", amountPaise: 0 }])).toContain("bill.no_lines");
  });

  it("rejects non-positive quantities and negative prices", () => {
    const bill = computeBill([line({ qtyMilli: 0 }), line({ itemId: 2, unitPricePaise: -5 })], {
      pricesIncludeTax: false,
    });
    const errors = validateBill(bill, [{ mode: "cash", amountPaise: 0 }]);
    expect(errors).toContain("line.qty_not_positive");
    expect(errors).toContain("line.negative_price");
  });

  it("rejects fractional quantity for count items but allows it for weight", () => {
    const countBill = computeBill([line({ qtyMilli: 1500 })], { pricesIncludeTax: false });
    expect(validateBill(countBill, [{ mode: "cash", amountPaise: 10_000 }])).toContain(
      "line.count_qty_not_whole",
    );
    const weightBill = computeBill([line({ qtyMilli: 1500, unitKind: "weight" })], {
      pricesIncludeTax: false,
    });
    expect(validateBill(weightBill, [{ mode: "cash", amountPaise: 10_000 }])).toEqual([]);
  });

  it("requires payments to cover the total", () => {
    const bill = computeBill([line()], { pricesIncludeTax: false });
    expect(validateBill(bill, [])).toContain("bill.no_payments");
    expect(validateBill(bill, [{ mode: "upi", amountPaise: 1 }])).toContain("payment.insufficient");
  });

  it("allows cash overpayment (change) but not non-cash overpayment", () => {
    const bill = computeBill([line()], { pricesIncludeTax: false }); // total 1050
    expect(validateBill(bill, [{ mode: "cash", amountPaise: 2000 }])).toEqual([]);
    expect(validateBill(bill, [{ mode: "upi", amountPaise: 2000 }])).toContain(
      "payment.overpay_requires_cash",
    );
  });

  it("supports split payments", () => {
    const bill = computeBill([line()], { pricesIncludeTax: false }); // 1050
    expect(
      validateBill(bill, [
        { mode: "cash", amountPaise: 1000 },
        { mode: "upi", amountPaise: 50 },
      ]),
    ).toEqual([]);
  });

  it("rejects unknown payment modes and non-positive amounts", () => {
    const bill = computeBill([line()], { pricesIncludeTax: false });
    const errors = validateBill(bill, [
      // @ts-expect-error deliberately invalid mode
      { mode: "bitcoin", amountPaise: 1050 },
      { mode: "cash", amountPaise: 0 },
    ]);
    expect(errors).toContain("payment.unknown_mode");
    expect(errors).toContain("payment.amount_not_positive");
  });
});

describe("computeChangePaise", () => {
  it("is the cash overpayment", () => {
    const bill = computeBill([line()], { pricesIncludeTax: false }); // 1050
    expect(computeChangePaise(bill, [{ mode: "cash", amountPaise: 2000 }])).toBe(950);
    expect(computeChangePaise(bill, [{ mode: "cash", amountPaise: 1050 }])).toBe(0);
  });
});

describe("validateVoidReason", () => {
  it("requires a non-blank reason", () => {
    expect(validateVoidReason("")).toBe("void.reason_required");
    expect(validateVoidReason("   ")).toBe("void.reason_required");
    expect(validateVoidReason("customer changed mind")).toBeNull();
  });
});

describe("isPaymentMode", () => {
  it("knows the four modes", () => {
    for (const m of ["cash", "upi", "card", "credit"]) expect(isPaymentMode(m)).toBe(true);
    expect(isPaymentMode("cheque")).toBe(false);
  });
});
