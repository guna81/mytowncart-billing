// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { isLowStock } from "@mytowncart-billing/core";
import type { ShopProfile } from "@mytowncart-billing/storage";
import { effectiveLowStockThreshold, isLowStockAlertsDisabled } from "./stockAlerts";

describe("stockAlerts", () => {
  const dummyProfile: ShopProfile = {
    name: "Test Shop",
    gstEnabled: true,
    pricesIncludeTax: true,
    invoicePrefix: "INV-",
    address: "",
    phone: "",
    gstin: "",
    receiptFooter: "",
    lowStockThresholdMilli: 5000,
    updatedAt: "2026-11-06T00:00:00.000Z",
  };

  it("returns 0 and isDisabled=true when profile is null or undefined", () => {
    expect(effectiveLowStockThreshold(null)).toBe(0);
    expect(effectiveLowStockThreshold(undefined)).toBe(0);
    expect(isLowStockAlertsDisabled(null)).toBe(true);
    expect(isLowStockAlertsDisabled(undefined)).toBe(true);
  });

  it("returns 0 and isDisabled=true when lowStockThresholdMilli is 0", () => {
    const profile = { ...dummyProfile, lowStockThresholdMilli: 0 };
    expect(effectiveLowStockThreshold(profile)).toBe(0);
    expect(isLowStockAlertsDisabled(profile)).toBe(true);
  });

  it("returns threshold value and isDisabled=false when positive", () => {
    expect(effectiveLowStockThreshold(dummyProfile)).toBe(5000);
    expect(isLowStockAlertsDisabled(dummyProfile)).toBe(false);

    const custom = { ...dummyProfile, lowStockThresholdMilli: 10000 };
    expect(effectiveLowStockThreshold(custom)).toBe(10000);
    expect(isLowStockAlertsDisabled(custom)).toBe(false);
  });

  it("never flags items as low stock when threshold is 0 (alerts disabled)", () => {
    const profile = { ...dummyProfile, lowStockThresholdMilli: 0 };
    const threshold = effectiveLowStockThreshold(profile);
    expect(threshold).toBe(0);

    const testStockValues = [0, 1000, 5000, 10000];
    const lowStockItems = testStockValues.filter((stock) => threshold > 0 && isLowStock(stock, threshold));
    expect(lowStockItems).toHaveLength(0);
  });

  it("correctly flags items as low stock when threshold is 5 units (5000 milli)", () => {
    const threshold = effectiveLowStockThreshold(dummyProfile);
    expect(threshold).toBe(5000);

    expect(isLowStock(0, threshold)).toBe(true);
    expect(isLowStock(2000, threshold)).toBe(true);
    expect(isLowStock(5000, threshold)).toBe(true);
    expect(isLowStock(5001, threshold)).toBe(false);
    expect(isLowStock(10000, threshold)).toBe(false);
  });
});
