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

describe("validateBill change", () => {
  it("rejects change larger than the cash tendered", () => {
    const bill = computeBill([line({ unitPricePaise: 10_000, taxRateBp: 0 })], { pricesIncludeTax: false });
    expect(
      validateBill(bill, [
        { mode: "upi", amountPaise: 12_000 },
        { mode: "cash", amountPaise: 1_000 },
      ]),
    ).toContain("payment.change_exceeds_cash");
    expect(validateBill(bill, [{ mode: "cash", amountPaise: 12_000 }])).toEqual([]);
    expect(
      validateBill(bill, [
        { mode: "upi", amountPaise: 6_000 },
        { mode: "cash", amountPaise: 5_000 },
      ]),
    ).toEqual([]);
  });
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

  it("applies line discounts and bill discounts proportionally", () => {
    // 2 lines: line 1 has price 1000 (taxRate 0), line 2 has price 2000 (taxRate 0).
    // line 1 line-discount: 100 -> net 900.
    // line 2 line-discount: 0 -> net 2000.
    // total provisional = 2900.
    // Bill discount: 290 paise.
    // Line 1 share: 90 paise. Total discount for line 1 = 190, net = 810.
    // Line 2 share: 200 paise. Total discount for line 2 = 200, net = 1800.
    // Total = 2610.
    const bill = computeBill(
      [
        line({ itemId: 1, unitPricePaise: 1000, taxRateBp: 0, discountPaise: 100 }),
        line({ itemId: 2, unitPricePaise: 2000, taxRateBp: 0, discountPaise: 0 }),
      ],
      { pricesIncludeTax: false, billDiscountPaise: 290 },
    );
    expect(bill.discountPaise).toBe(390);
    expect(bill.lines[0]!.discountPaise).toBe(190);
    expect(bill.lines[1]!.discountPaise).toBe(200);
    expect(bill.totalPaise).toBe(2610);
  });

  it("bill discount lowers the payable total by exactly that amount on tax-exclusive prices", () => {
    // Rs 1000 + 18% GST = Rs 1180. A Rs 100 bill discount must give Rs 1080, not Rs 1062.
    const bill = computeBill([line({ unitPricePaise: 100_000, taxRateBp: 1800 })], {
      pricesIncludeTax: false,
      billDiscountPaise: 10_000,
    });
    expect(bill.totalPaise).toBe(108_000);
    // mixed rates: reduction is within 1 paise per line
    const mixed = computeBill(
      [
        line({ itemId: 1, unitPricePaise: 50_000, taxRateBp: 1800 }),
        line({ itemId: 2, unitPricePaise: 50_000, taxRateBp: 500 }),
      ],
      { pricesIncludeTax: false, billDiscountPaise: 10_000 },
    );
    expect(Math.abs(mixed.totalPaise - (59_000 + 52_500 - 10_000))).toBeLessThanOrEqual(2);
  });

  it("bill discount is exact on tax-inclusive prices", () => {
    const bill = computeBill([line({ unitPricePaise: 118_000, taxRateBp: 1800 })], {
      pricesIncludeTax: true,
      billDiscountPaise: 10_000,
    });
    expect(bill.totalPaise).toBe(108_000);
  });

  it("applies round-off to nearest rupee when enabled", () => {
    // total 1050 paise (₹10.50) -> rounds up to 1100 (+50 paise)
    const billUp = computeBill([line({ unitPricePaise: 1000, taxRateBp: 500 })], {
      pricesIncludeTax: false,
      roundOff: true,
    });
    expect(billUp.unroundedTotalPaise).toBe(1050);
    expect(billUp.roundOffPaise).toBe(50);
    expect(billUp.totalPaise).toBe(1100);

    // total 1040 paise (₹10.40) -> rounds down to 1000 (-40 paise)
    const billDown = computeBill([line({ unitPricePaise: 1000, taxRateBp: 400 })], {
      pricesIncludeTax: false,
      roundOff: true,
    });
    expect(billDown.unroundedTotalPaise).toBe(1040);
    expect(billDown.roundOffPaise).toBe(-40);
    expect(billDown.totalPaise).toBe(1000);
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

  it("enforces customer requirement for credit sales", () => {
    const bill = computeBill([line()], { pricesIncludeTax: false }); // 1050
    // Credit without customer -> error
    expect(
      validateBill(bill, [{ mode: "credit", amountPaise: 1050 }]),
    ).toContain("payment.credit_requires_customer");

    // Credit with customer -> accepted
    expect(
      validateBill(bill, [{ mode: "credit", amountPaise: 1050 }], { customerId: 42 }),
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
