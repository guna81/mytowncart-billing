// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { computeLineAmounts, splitGst } from "../src/tax";

describe("computeLineAmounts — tax-exclusive pricing", () => {
  it("adds tax on top of the net", () => {
    // ₹100 net at 18%: tax ₹18, total ₹118.
    const r = computeLineAmounts({
      qtyMilli: 1000,
      unitPricePaise: 10_000,
      taxRateBp: 1800,
      pricesIncludeTax: false,
    });
    expect(r).toEqual({ netPaise: 10_000, taxPaise: 1800, totalPaise: 11_800, cgstPaise: 900, sgstPaise: 900 });
  });

  it("multiplies by fractional quantity (0.5 kg at ₹80/kg, 5%)", () => {
    const r = computeLineAmounts({
      qtyMilli: 500,
      unitPricePaise: 8000,
      taxRateBp: 500,
      pricesIncludeTax: false,
    });
    // net 4000, tax 200, total 4200
    expect(r.netPaise).toBe(4000);
    expect(r.taxPaise).toBe(200);
    expect(r.totalPaise).toBe(4200);
  });

  it("handles zero tax", () => {
    const r = computeLineAmounts({
      qtyMilli: 2000,
      unitPricePaise: 1550,
      taxRateBp: 0,
      pricesIncludeTax: false,
    });
    expect(r).toEqual({ netPaise: 3100, taxPaise: 0, totalPaise: 3100, cgstPaise: 0, sgstPaise: 0 });
  });

  it("rounds line tax half away from zero", () => {
    // net 1 paise at 50% -> 0.5 -> 1 paise tax.
    const r = computeLineAmounts({
      qtyMilli: 1000,
      unitPricePaise: 1,
      taxRateBp: 5000,
      pricesIncludeTax: false,
    });
    expect(r.taxPaise).toBe(1);
    expect(r.totalPaise).toBe(2);
  });

  it("rounds the line net from fractional quantity first, then the tax", () => {
    // ₹0.03/unit × 0.5 = 1.5 paise -> net 2; tax 18% of 2 = 0.36 -> 0.
    const r = computeLineAmounts({
      qtyMilli: 500,
      unitPricePaise: 3,
      taxRateBp: 1800,
      pricesIncludeTax: false,
    });
    expect(r.netPaise).toBe(2);
    expect(r.taxPaise).toBe(0);
    expect(r.totalPaise).toBe(2);
  });
});

describe("computeLineAmounts — tax-inclusive pricing", () => {
  it("backs tax out of the gross", () => {
    // ₹118 inclusive at 18% -> tax ₹18, net ₹100.
    const r = computeLineAmounts({
      qtyMilli: 1000,
      unitPricePaise: 11_800,
      taxRateBp: 1800,
      pricesIncludeTax: true,
    });
    expect(r).toEqual({ netPaise: 10_000, taxPaise: 1800, totalPaise: 11_800, cgstPaise: 900, sgstPaise: 900 });
  });

  it("keeps total = qty × unit price exactly (customer-facing price)", () => {
    // ₹10 MRP-style price, 5% included, qty 3.
    const r = computeLineAmounts({
      qtyMilli: 3000,
      unitPricePaise: 1000,
      taxRateBp: 500,
      pricesIncludeTax: true,
    });
    expect(r.totalPaise).toBe(3000);
    // tax = 3000 * 500 / 10500 = 142.857 -> 143; net = 2857
    expect(r.taxPaise).toBe(143);
    expect(r.netPaise).toBe(2857);
  });

  it("handles zero tax inclusive", () => {
    const r = computeLineAmounts({
      qtyMilli: 1000,
      unitPricePaise: 999,
      taxRateBp: 0,
      pricesIncludeTax: true,
    });
    expect(r).toEqual({ netPaise: 999, taxPaise: 0, totalPaise: 999, cgstPaise: 0, sgstPaise: 0 });
  });

  it("rounds half away from zero when backing tax out", () => {
    // gross 1 paise at 10000bp (100%) -> tax = 1*10000/20000 = 0.5 -> 1, net 0.
    const r = computeLineAmounts({
      qtyMilli: 1000,
      unitPricePaise: 1,
      taxRateBp: 10_000,
      pricesIncludeTax: true,
    });
    expect(r.taxPaise).toBe(1);
    expect(r.netPaise).toBe(0);
    expect(r.totalPaise).toBe(1);
  });
});

describe("splitGst", () => {
  it("splits evenly", () => {
    expect(splitGst(1800)).toEqual({ cgstPaise: 900, sgstPaise: 900 });
  });
  it("gives the odd paise to SGST so the split always sums exactly", () => {
    const { cgstPaise, sgstPaise } = splitGst(143);
    expect(cgstPaise).toBe(72); // 71.5 -> half away from zero
    expect(sgstPaise).toBe(71);
    expect(cgstPaise + sgstPaise).toBe(143);
  });
  it("handles zero and one paise", () => {
    expect(splitGst(0)).toEqual({ cgstPaise: 0, sgstPaise: 0 });
    expect(splitGst(1)).toEqual({ cgstPaise: 1, sgstPaise: 0 });
  });
});

describe("edge cases", () => {
  it("rejects negative tax rates", () => {
    expect(() =>
      computeLineAmounts({ qtyMilli: 1000, unitPricePaise: 100, taxRateBp: -1, pricesIncludeTax: false }),
    ).toThrow();
  });
  it("handles large values within safe-integer range", () => {
    const r = computeLineAmounts({
      qtyMilli: 1_000_000, // 1000 units
      unitPricePaise: 999_999_00, // ₹999,999.00
      taxRateBp: 2800,
      pricesIncludeTax: false,
    });
    expect(r.netPaise).toBe(999_999_000_00);
    expect(r.totalPaise).toBe(r.netPaise + r.taxPaise);
  });
});
