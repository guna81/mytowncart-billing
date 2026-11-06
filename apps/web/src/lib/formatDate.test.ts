// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { formatDate, formatDateRange, formatDateTime, formatTime } from "./formatDate";

describe("formatDate helper", () => {
  it("formats valid dates consistently as 'D MMM YYYY'", () => {
    const d = new Date(2026, 10, 6); // 6 Nov 2026
    expect(formatDate(d)).toBe("6 Nov 2026");
  });

  it("formats ISO string timestamps", () => {
    // Note: Use UTC or localized time
    const d = new Date(2026, 0, 15, 10, 30);
    expect(formatDate(d.toISOString())).toBe("15 Jan 2026");
  });

  it("handles invalid or empty inputs gracefully", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("invalid-date-string")).toBe("—");
    expect(formatDate(null, "N/A")).toBe("N/A");
  });

  it("formats date and time accurately", () => {
    const d = new Date(2026, 10, 6, 15, 53, 48);
    expect(formatDateTime(d)).toBe("6 Nov 2026, 15:53:48");
  });

  it("formats time correctly", () => {
    const d = new Date(2026, 10, 6, 9, 5, 7);
    expect(formatTime(d)).toBe("09:05:07");
  });

  it("formats date ranges", () => {
    const start = new Date(2026, 9, 8); // 8 Oct 2026
    const end = new Date(2026, 10, 6); // 6 Nov 2026
    expect(formatDateRange(start, end)).toBe("8 Oct 2026 → 6 Nov 2026");
  });
});
