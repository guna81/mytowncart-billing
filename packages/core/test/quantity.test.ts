// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { formatQty, isUnitKind, isWholeCount, parseQty } from "../src/quantity";

describe("isUnitKind", () => {
  it("accepts the three kinds", () => {
    expect(isUnitKind("count")).toBe(true);
    expect(isUnitKind("weight")).toBe(true);
    expect(isUnitKind("volume")).toBe(true);
    expect(isUnitKind("piece")).toBe(false);
    expect(isUnitKind("")).toBe(false);
  });
});

describe("isWholeCount", () => {
  it("requires whole units", () => {
    expect(isWholeCount(0)).toBe(true);
    expect(isWholeCount(1000)).toBe(true);
    expect(isWholeCount(-2000)).toBe(true);
    expect(isWholeCount(1500)).toBe(false);
    expect(isWholeCount(1)).toBe(false);
  });
});

describe("formatQty", () => {
  it("formats with up to three decimals, trimming zeros", () => {
    expect(formatQty(0)).toBe("0");
    expect(formatQty(1000)).toBe("1");
    expect(formatQty(2000)).toBe("2");
    expect(formatQty(1500)).toBe("1.5");
    expect(formatQty(1250)).toBe("1.25");
    expect(formatQty(250)).toBe("0.25");
    expect(formatQty(1)).toBe("0.001");
    expect(formatQty(-1500)).toBe("-1.5");
  });
});

describe("parseQty", () => {
  it("parses integers and up-to-3dp decimals", () => {
    expect(parseQty("0")).toBe(0);
    expect(parseQty("2")).toBe(2000);
    expect(parseQty("1.5")).toBe(1500);
    expect(parseQty("0.250")).toBe(250);
    expect(parseQty("0.001")).toBe(1);
    expect(parseQty("-1.5")).toBe(-1500);
    expect(parseQty(" 2 ")).toBe(2000);
  });
  it("rejects malformed input", () => {
    expect(parseQty("")).toBeNull();
    expect(parseQty("1.5kg")).toBeNull();
    expect(parseQty("1.0001")).toBeNull();
    expect(parseQty("abc")).toBeNull();
    expect(parseQty(".5")).toBeNull();
  });
  it("round-trips with formatQty", () => {
    for (const v of [0, 1, 250, 1000, 1250, -2000]) {
      expect(parseQty(formatQty(v))).toBe(v);
    }
  });
});
