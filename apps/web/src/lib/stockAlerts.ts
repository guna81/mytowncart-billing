// SPDX-License-Identifier: Apache-2.0
import type { ShopProfile } from "@mytowncart-billing/storage";

/**
 * Returns the effective low-stock threshold in milli-units (e.g. 5000 = 5 units).
 * Defaults to 0 if profile is missing or threshold is not set.
 */
export function effectiveLowStockThreshold(profile: ShopProfile | null | undefined): number {
  return profile?.lowStockThresholdMilli ?? 0;
}

/**
 * Returns true if low-stock alerts are disabled (i.e. threshold is 0).
 */
export function isLowStockAlertsDisabled(profile: ShopProfile | null | undefined): boolean {
  return effectiveLowStockThreshold(profile) === 0;
}
