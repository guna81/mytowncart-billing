// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createCustomer, createItem, ensureSetup } from "./helpers";

test.describe("Phase 3: Customer Loyalty Points & Rewards", () => {
  test.beforeEach(async ({ page }) => {
    await ensureSetup(page);
  });

  test("accrues points on bill, shows balance, and supports POS points redemption", async ({ page }) => {
    const code = `890${Date.now().toString().slice(-10)}`;
    await createItem(page, {
      name: "Heritage Milk 1L",
      barcode: code,
      price: "100.00",
      openingStock: "50",
    });

    const custName = `Loyal Patron ${Date.now().toString().slice(-4)}`;
    await createCustomer(page, {
      name: custName,
      phone: "9876123450",
    });

    // 1. Bill customer ₹500 to earn 5 loyalty points
    await page.goto("/#/");
    await page.getByTestId("pos-scan").fill(code);
    await page.getByTestId("pos-scan").press("Enter");
    await page.getByTestId("pos-customer").selectOption({ label: custName });

    // Increase qty to 5 units = ₹500
    const qtyInput = page.locator("input[data-testid^='pos-qty-']");
    await qtyInput.fill("5");
    await qtyInput.press("Enter");

    await page.getByTestId("pos-save").click();
    await expect(page.getByTestId("pos-notice")).toContainText(/INV-/);

    // 2. Verify loyalty points balance in Customers screen
    await page.goto("/#/customers");
    await expect(page.locator("body")).toContainText(custName);
    await expect(page.locator("body")).toContainText("5 pts");

    // 3. Directly grant 20 additional points via storage or bill another ₹1500 to reach redemption threshold
    await page.goto("/#/");
    await page.getByTestId("pos-scan").fill(code);
    await page.getByTestId("pos-scan").press("Enter");
    await page.getByTestId("pos-customer").selectOption({ label: custName });

    const qtyInput2 = page.locator("input[data-testid^='pos-qty-']");
    await qtyInput2.fill("10");
    await qtyInput2.press("Enter");
    await page.getByTestId("pos-save").click();
    await expect(page.getByTestId("pos-notice")).toContainText(/INV-/);

    // Now customer has 15 points (>= minPointsToRedeem = 10 points)
    // 4. In next bill, select customer and test loyalty points redemption widget
    await page.getByTestId("pos-scan").fill(code);
    await page.getByTestId("pos-scan").press("Enter");
    await page.getByTestId("pos-customer").selectOption({ label: custName });

    await expect(page.getByTestId("pos-loyalty-panel")).toBeVisible();
    await expect(page.getByTestId("pos-loyalty-balance")).toContainText("15 pts");

    // Click Redeem
    await page.getByTestId("pos-loyalty-redeem").click();
    await expect(page.getByTestId("pos-loyalty-applied")).toBeVisible();

    // Bill total payable should reflect discount (₹100 - ₹15 = ₹85)
    await expect(page.getByTestId("pos-total")).toContainText("85.00");
  });
});
