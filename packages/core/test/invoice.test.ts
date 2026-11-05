// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  financialYearFor,
  formatInvoiceNumber,
  fyEndDate,
  fyLabel,
  fyStartDate,
  isoDateOf,
  localIsoTimestamp,
} from "../src/invoice";

describe("financialYearFor (April–March)", () => {
  it("maps dates to the right FY", () => {
    expect(financialYearFor("2026-01-15")).toBe("2025-26");
    expect(financialYearFor("2026-06-15")).toBe("2026-27");
  });
  it("handles the FY boundary exactly", () => {
    expect(financialYearFor("2026-03-31")).toBe("2025-26");
    expect(financialYearFor("2026-04-01")).toBe("2026-27");
    expect(financialYearFor("2025-04-01")).toBe("2025-26");
    expect(financialYearFor("2027-03-31")).toBe("2026-27");
  });
  it("handles January 1st (still the previous FY)", () => {
    expect(financialYearFor("2027-01-01")).toBe("2026-27");
    expect(financialYearFor("2027-12-31")).toBe("2027-28");
  });
  it("rejects malformed dates", () => {
    expect(() => financialYearFor("31-03-2026")).toThrow();
    expect(() => financialYearFor("2026-13-01")).toThrow();
    expect(() => financialYearFor("")).toThrow();
  });
});

describe("fyLabel / fyStartDate / fyEndDate", () => {
  it("round-trips", () => {
    expect(fyLabel(2026)).toBe("2026-27");
    expect(fyLabel(1999)).toBe("1999-00");
    expect(fyStartDate("2026-27")).toBe("2026-04-01");
    expect(fyEndDate("2026-27")).toBe("2027-03-31");
  });
  it("start/end dates fall in the same FY", () => {
    expect(financialYearFor(fyStartDate("2026-27"))).toBe("2026-27");
    expect(financialYearFor(fyEndDate("2026-27"))).toBe("2026-27");
  });
});

describe("formatInvoiceNumber", () => {
  it("pads to at least four digits", () => {
    expect(formatInvoiceNumber("INV-", 1)).toBe("INV-0001");
    expect(formatInvoiceNumber("INV-", 42)).toBe("INV-0042");
    expect(formatInvoiceNumber("INV-", 9999)).toBe("INV-9999");
  });
  it("does not truncate longer sequences", () => {
    expect(formatInvoiceNumber("INV-", 10_000)).toBe("INV-10000");
    expect(formatInvoiceNumber("INV-", 1_234_567)).toBe("INV-1234567");
  });
  it("honours any prefix", () => {
    expect(formatInvoiceNumber("MTC/", 7)).toBe("MTC/0007");
    expect(formatInvoiceNumber("", 7)).toBe("0007");
  });
  it("rejects non-positive or fractional sequences", () => {
    expect(() => formatInvoiceNumber("INV-", 0)).toThrow();
    expect(() => formatInvoiceNumber("INV-", -1)).toThrow();
    expect(() => formatInvoiceNumber("INV-", 1.5)).toThrow();
  });
});

describe("isoDateOf", () => {
  it("formats a Date as a local ISO calendar date", () => {
    expect(isoDateOf(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(isoDateOf(new Date(2026, 10, 4))).toBe("2026-11-04");
  });
});

describe("localIsoTimestamp", () => {
  it("prefixes the local calendar date, not the UTC one", () => {
    const lateEvening = new Date(2026, 10, 5, 23, 59, 30, 250);
    const stamp = localIsoTimestamp(lateEvening);
    expect(stamp.slice(0, 10)).toBe("2026-11-05");
    expect(stamp.slice(0, 19)).toBe("2026-11-05T23:59:30");
    expect(stamp).toMatch(/\.250[+-]\d{2}:\d{2}$/);
  });
  it("round-trips to the same instant", () => {
    const d = new Date(2026, 0, 1, 0, 0, 0, 0);
    expect(new Date(localIsoTimestamp(d)).getTime()).toBe(d.getTime());
  });
});
