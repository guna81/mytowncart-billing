// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { ensureSetup } from "./helpers";

test.describe("Phase 3: Day-End Closing & Cash Drawer Reconciliation Z-Report", () => {
  test.beforeEach(async ({ page }) => {
    await ensureSetup(page);
  });

  test("calculates denomination totals, computes variance, saves closure, and prints Z-report", async ({
    page,
  }) => {
    // 1. Navigate to Day-End Closing Screen
    await page.goto("/#/day-end");
    await expect(page.locator("h1")).toContainText("Day-End Closing & Cash Drawer");

    // 2. Set Opening float cash to ₹1500.00
    const openingInput = page.getByTestId("opening-cash-input");
    await openingInput.fill("1500.00");

    // 3. Enter Denomination Counts
    // e.g. 2 x ₹500 (₹1000), 5 x ₹100 (₹500), 10 x ₹10 (₹100) -> total = ₹1600.00
    await page.getByTestId("denom-500").fill("2");
    await page.getByTestId("denom-100").fill("5");
    await page.getByTestId("denom-10").fill("10");

    // Verify counted cash total displays ₹1600.00
    await expect(page.getByTestId("counted-cash-total")).toContainText("1600.00");

    // Variance should reflect surplus/shortage compared to expected (expected = 1500 + 0 = 1500)
    // Counted 1600 - Expected 1500 = +100.00 (Cash Surplus)
    await expect(page.getByTestId("cash-variance-box")).toBeVisible();
    await expect(page.getByTestId("cash-variance-value")).toContainText("+₹100.00");

    // 4. Fill closing notes and save day-end closure
    await page.getByTestId("day-end-notes").fill("Shift balanced by cashier with ₹100 surplus");
    await page.getByTestId("day-end-save-btn").click();

    // Check success notification
    await expect(page.locator("body")).toContainText("Day-end closing saved successfully");

    // Check closure row appears in Past Closures table
    await expect(page.locator("body")).toContainText("Shift balanced by cashier with ₹100 surplus");

    // 5. Trigger Print Z-Report
    await page.evaluate(() => {
      window.print = () => {};
    });

    await page.getByTestId("day-end-print-btn").click();
    await expect(page.getByTestId("print-view")).toBeVisible();
    await expect(page.getByTestId("z-report-doc")).toBeVisible();
    await expect(page.getByTestId("z-report-doc")).toContainText("DAY-END CLOSING (Z-REPORT)");
    await expect(page.getByTestId("z-report-doc")).toContainText("1600.00");

    // Close print view
    await page.getByTestId("print-close").click();
    await expect(page.getByTestId("print-view")).not.toBeVisible();
  });
});
