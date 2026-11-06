// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  computeCashVariance,
  computeDenominationsTotalPaise,
  computeExpectedDrawerCash,
  computeLoyaltyPointsEarned,
  computeLoyaltyRedemption,
  generateGstr1Dataset,
  isBatchExpired,
  isBatchNearExpiry,
  serializeGstr1Csvs,
  sortBatchesFifo,
  type ReportBill,
} from "../src";

describe("Phase 3 Core Domain", () => {
  describe("Batch & Expiry", () => {
    const fixedNow = new Date("2026-11-06T12:00:00Z");

    it("detects expired batches", () => {
      expect(isBatchExpired("2026-11-05", fixedNow)).toBe(true);
      expect(isBatchExpired("2026-11-06", fixedNow)).toBe(false); // Valid until end of today
      expect(isBatchExpired("2026-12-01", fixedNow)).toBe(false);
    });

    it("detects near-expiry batches within threshold", () => {
      // 10 days out is within default 30 days
      expect(isBatchNearExpiry("2026-11-16", 30, fixedNow)).toBe(true);
      // 45 days out is not within 30 days
      expect(isBatchNearExpiry("2026-12-25", 30, fixedNow)).toBe(false);
      // Already expired is not near-expiry
      expect(isBatchNearExpiry("2026-11-01", 30, fixedNow)).toBe(false);
    });

    it("sorts batches FIFO by expiry date", () => {
      const batches = [
        { batchNo: "B3", expiryDate: "2027-01-01" },
        { batchNo: "B1", expiryDate: "2026-11-20" },
        { batchNo: "B2", expiryDate: "2026-12-15" },
      ];
      const sorted = sortBatchesFifo(batches);
      expect(sorted.map((b) => b.batchNo)).toEqual(["B1", "B2", "B3"]);
    });
  });

  describe("Loyalty Points", () => {
    it("computes points earned based on earn rate", () => {
      // ₹100 spent = 1 point (10000 paise)
      expect(computeLoyaltyPointsEarned(10000)).toBe(1);
      expect(computeLoyaltyPointsEarned(25000)).toBe(2);
      expect(computeLoyaltyPointsEarned(9900)).toBe(0);
      expect(computeLoyaltyPointsEarned(0)).toBe(0);
    });

    it("computes loyalty points redemption", () => {
      // Available 50 points, request 20 points, bill total ₹500 (50000 paise)
      const res = computeLoyaltyRedemption(50, 20, 50000);
      expect(res.pointsRedeemed).toBe(20);
      expect(res.discountPaise).toBe(2000); // ₹20 off

      // Cannot redeem more than bill total
      const resCap = computeLoyaltyRedemption(50, 50, 3000); // Bill is only ₹30
      expect(resCap.pointsRedeemed).toBe(30);
      expect(resCap.discountPaise).toBe(3000); // ₹30 off

      // Below minimum required points (10)
      const resMin = computeLoyaltyRedemption(5, 5, 50000);
      expect(resMin.pointsRedeemed).toBe(0);
      expect(resMin.discountPaise).toBe(0);
    });
  });

  describe("Day-End & Cash Drawer", () => {
    it("computes total cash in drawer from denominations", () => {
      const counts = {
        n500: 4,  // ₹2,000 = 200,000 paise
        n200: 5,  // ₹1,000 = 100,000 paise
        n100: 10, // ₹1,000 = 100,000 paise
        n50: 6,   // ₹300   = 30,000 paise
        coins: 45,// ₹45    = 4,500 paise
      };
      expect(computeDenominationsTotalPaise(counts)).toBe(434500); // ₹4,345.00
    });

    it("computes expected cash and cash variance", () => {
      // Opening ₹1000 + Cash Sales ₹5000 + Customer Payments ₹500 - Cash Returns ₹200 = ₹6300 expected
      const expected = computeExpectedDrawerCash(100000, 500000, 50000, 20000);
      expect(expected).toBe(630000);

      // Actual ₹6350 -> +₹50 over
      expect(computeCashVariance(635000, expected)).toBe(5000);

      // Actual ₹6200 -> -₹100 short
      expect(computeCashVariance(620000, expected)).toBe(-10000);
    });
  });

  describe("GSTR-1 Tax Engine", () => {
    it("generates B2B, B2C, and HSN summary correctly", () => {
      const bills: ReportBill[] = [
        {
          id: 1,
          number: "INV-001",
          status: "active",
          createdAt: "2026-11-06T10:00:00Z",
          subtotalPaise: 10000,
          taxPaise: 500,
          totalPaise: 10500,
          lines: [
            {
              itemId: 10,
              nameSnapshot: "Basmati Rice 1kg",
              qtyMilli: 1000,
              totalPaise: 10500,
              taxPaise: 500,
            },
          ],
          payments: [{ mode: "cash", amountPaise: 10500 }],
        },
      ];

      const customersMap = new Map();
      const dataset = generateGstr1Dataset(bills, customersMap);

      expect(dataset.b2csRows.length).toBe(1);
      expect(dataset.b2csRows[0]!.ratePct).toBe("5%");
      expect(dataset.hsnRows.length).toBe(1);
      expect(dataset.hsnRows[0]!.totalQty).toBe("1");

      const csvs = serializeGstr1Csvs(dataset);
      expect(csvs.b2csCsv).toContain("5%");
      expect(csvs.hsnCsv).toContain("Basmati Rice 1kg");
    });
  });
});
