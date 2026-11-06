// SPDX-License-Identifier: Apache-2.0

/**
 * Pure domain logic for Customer Loyalty Points & Rewards.
 */

export interface LoyaltyConfig {
  enabled: boolean;
  /** Amount in paise spent to earn 1 loyalty point (default ₹100 = 10,000 paise). */
  earnRatePaise: number;
  /** Value of 1 loyalty point when redeemed in paise (default ₹1 = 100 paise). */
  pointValuePaise: number;
  /** Minimum points balance required before redemption is permitted (default 10 points). */
  minPointsToRedeem: number;
}

export const DEFAULT_LOYALTY_CONFIG: LoyaltyConfig = {
  enabled: true,
  earnRatePaise: 10_000, // 1 point per ₹100
  pointValuePaise: 100,  // 1 point = ₹1
  minPointsToRedeem: 10, // Must have at least 10 pts
};

/**
 * Calculate loyalty points earned on a bill total.
 * Only positive total earns points. Fractional points are floored.
 */
export function computeLoyaltyPointsEarned(
  totalPaise: number,
  earnRatePaise: number = DEFAULT_LOYALTY_CONFIG.earnRatePaise,
): number {
  if (totalPaise <= 0 || earnRatePaise <= 0) return 0;
  return Math.floor(totalPaise / earnRatePaise);
}

/**
 * Calculate redemption discount and actual points to deduct.
 * Ensures discount does not exceed the bill total.
 */
export function computeLoyaltyRedemption(
  availablePoints: number,
  requestedPoints: number,
  maxBillPaise: number,
  pointValuePaise: number = DEFAULT_LOYALTY_CONFIG.pointValuePaise,
  minPoints: number = DEFAULT_LOYALTY_CONFIG.minPointsToRedeem,
): { pointsRedeemed: number; discountPaise: number } {
  if (availablePoints < minPoints || requestedPoints <= 0 || maxBillPaise <= 0 || pointValuePaise <= 0) {
    return { pointsRedeemed: 0, discountPaise: 0 };
  }

  const eligiblePoints = Math.min(availablePoints, requestedPoints);
  const maxPointsForBill = Math.floor(maxBillPaise / pointValuePaise);
  const pointsRedeemed = Math.min(eligiblePoints, maxPointsForBill);
  const discountPaise = pointsRedeemed * pointValuePaise;

  return { pointsRedeemed, discountPaise };
}
