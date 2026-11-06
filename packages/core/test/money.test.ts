// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  addPaise,
  allocatePaise,
  amountInWords,
  formatPaise,
  mulBps,
  mulQtyMilli,
  parsePaise,
  roundDiv,
  subPaise,
} from "../src/money";

describe("addPaise/subPaise", () => {
  it("adds and subtracts integers", () => {
    expect(addPaise(1, 2, 3)).toBe(6);
    expect(addPaise()).toBe(0);
    expect(subPaise(100, 250)).toBe(-150);
  });
  it("rejects non-integers", () => {
    expect(() => addPaise(1.5, 2)).toThrow();
    expect(() => addPaise(Number.MAX_SAFE_INTEGER, 1)).toThrow();
  });
});

describe("roundDiv (round half away from zero)", () => {
  it("rounds halves up for positive values", () => {
    expect(roundDiv(5, 2)).toBe(3); // 2.5 -> 3
    expect(roundDiv(1, 2)).toBe(1); // 0.5 -> 1
    expect(roundDiv(3, 2)).toBe(2); // 1.5 -> 2
  });
  it("rounds halves away from zero for negative values", () => {
    expect(roundDiv(-5, 2)).toBe(-3); // -2.5 -> -3
    expect(roundDiv(-1, 2)).toBe(-1); // -0.5 -> -1
  });
  it("rounds to nearest below the half", () => {
    expect(roundDiv(499, 1000)).toBe(0);
    expect(roundDiv(500, 1000)).toBe(1);
    expect(roundDiv(501, 1000)).toBe(1);
    expect(roundDiv(1499, 1000)).toBe(1);
    expect(roundDiv(1500, 1000)).toBe(2);
  });
  it("handles exact division and zero", () => {
    expect(roundDiv(0, 7)).toBe(0);
    expect(roundDiv(700, 7)).toBe(100);
  });
  it("rejects a non-positive denominator", () => {
    expect(() => roundDiv(1, 0)).toThrow();
    expect(() => roundDiv(1, -2)).toThrow();
  });
});

describe("mulBps", () => {
  it("computes basis points of a paise amount", () => {
    expect(mulBps(10_000, 500)).toBe(500); // 5% of ₹100
    expect(mulBps(10_000, 1800)).toBe(1800); // 18%
    expect(mulBps(10_000, 0)).toBe(0);
  });
  it("rounds half away from zero", () => {
    expect(mulBps(1, 5000)).toBe(1); // 0.5 -> 1
    expect(mulBps(3, 5000)).toBe(2); // 1.5 -> 2
    expect(mulBps(-1, 5000)).toBe(-1); // -0.5 -> -1
  });
});

describe("mulQtyMilli", () => {
  it("multiplies by fractional quantity", () => {
    expect(mulQtyMilli(1000, 2_000)).toBe(2000); // 2 units
    expect(mulQtyMilli(1000, 500)).toBe(500); // 0.5 unit
    expect(mulQtyMilli(99, 1_500)).toBe(149); // 99 * 1.5 = 148.5 -> 149
  });
  it("rounds half away from zero", () => {
    expect(mulQtyMilli(1, 500)).toBe(1); // 0.5 -> 1
  });
});

describe("allocatePaise", () => {
  it("splits proportionally and sums exactly", () => {
    expect(allocatePaise(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocatePaise(101, [1, 1, 1])).toEqual([34, 34, 33]);
    expect(allocatePaise(10, [1, 3])).toEqual([3, 7]);
  });
  it("handles zero weights and single shares", () => {
    expect(allocatePaise(50, [0, 1])).toEqual([0, 50]);
    expect(allocatePaise(50, [1])).toEqual([50]);
    expect(allocatePaise(0, [1, 1])).toEqual([0, 0]);
  });
  it("breaks ties toward the earlier index", () => {
    expect(allocatePaise(1, [1, 1])).toEqual([1, 0]);
  });
  it("allocates negative totals (sum exact)", () => {
    const parts = allocatePaise(-100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-100);
  });
  it("rejects empty/degenerate weights", () => {
    expect(() => allocatePaise(5, [])).toThrow();
    expect(() => allocatePaise(5, [0, 0])).toThrow();
    expect(() => allocatePaise(5, [1, -1])).toThrow();
  });
});

describe("formatPaise", () => {
  it("formats with two decimals", () => {
    expect(formatPaise(0)).toBe("0.00");
    expect(formatPaise(5)).toBe("0.05");
    expect(formatPaise(50)).toBe("0.50");
    expect(formatPaise(1234)).toBe("12.34");
    expect(formatPaise(1_000_000)).toBe("10000.00");
    expect(formatPaise(-50)).toBe("-0.50");
    expect(formatPaise(-1234)).toBe("-12.34");
  });
});

describe("parsePaise", () => {
  it("parses whole and decimal strings", () => {
    expect(parsePaise("0")).toBe(0);
    expect(parsePaise("12")).toBe(1200);
    expect(parsePaise("12.3")).toBe(1230);
    expect(parsePaise("12.34")).toBe(1234);
    expect(parsePaise("-0.50")).toBe(-50);
    expect(parsePaise(" 12.34 ")).toBe(1234);
  });
  it("rejects malformed input", () => {
    expect(parsePaise("")).toBeNull();
    expect(parsePaise("abc")).toBeNull();
    expect(parsePaise("12.345")).toBeNull(); // too many decimals
    expect(parsePaise("12.")).toBeNull();
    expect(parsePaise(".5")).toBeNull();
    expect(parsePaise("1,234.56")).toBeNull(); // no comma stripping
    expect(parsePaise("--5")).toBeNull();
  });
  it("round-trips with formatPaise", () => {
    for (const v of [0, 1, 99, 100, 1234, -1234, 9_999_999]) {
      expect(parsePaise(formatPaise(v))).toBe(v);
    }
  });
});

describe("amountInWords", () => {
  it("converts zero and simple amounts", () => {
    expect(amountInWords(0)).toBe("Zero Rupees Only");
    expect(amountInWords(100)).toBe("One Rupees Only");
    expect(amountInWords(50)).toBe("Fifty Paise Only");
    expect(amountInWords(150)).toBe("One Rupees and Fifty Paise Only");
  });

  it("handles complex amounts with lakhs and crores", () => {
    expect(amountInWords(125050)).toBe("One Thousand Two Hundred and Fifty Rupees and Fifty Paise Only");
    expect(amountInWords(10_000_000)).toBe("One Lakh Rupees Only");
    expect(amountInWords(25_000_000)).toBe("Two Lakh Fifty Thousand Rupees Only");
    expect(amountInWords(100_000_000)).toBe("Ten Lakh Rupees Only");
    expect(amountInWords(1_000_000_000)).toBe("One Crore Rupees Only");
    expect(amountInWords(5_23_45_678_00)).toBe(
      "Five Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred and Seventy-Eight Rupees Only",
    );
  });
});
