// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
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
});
