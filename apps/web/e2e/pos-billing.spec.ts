// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createItem, ensureSetup } from "./helpers";

test.describe("POS Billing Flow", () => {
  test("creates items, performs search-as-you-type, discounts, quick cash, and saves bill", async ({
    page,
  }) => {
    await ensureSetup(page);

    // Create item with HSN & cost price
    await createItem(page, {
      name: "Parle-G Gold 100g",
      barcode: "8901234567890",
      price: "25.00",
      costPrice: "20.00",
      hsnCode: "1905",
      openingStock: "100",
    });

    await createItem(page, {
      name: "Amul Butter 100g",
      barcode: "8909876543210",
      price: "56.00",
      hsnCode: "0402",
      openingStock: "50",
    });

    // Go to POS screen
    await page.goto("/#/");
    await expect(page.getByTestId("pos-scan")).toBeVisible();

    // Test Search-as-you-type
    await page.getByTestId("pos-scan").fill("Parle");
    await expect(page.getByTestId("pos-suggestions")).toBeVisible();
    await page.getByText("Parle-G Gold 100g").click();

    // Verify item added to cart with HSN code displayed
    await expect(page.getByText("Parle-G Gold 100g")).toBeVisible();
    await expect(page.getByText("HSN: 1905")).toBeVisible();

    // Scan second item by barcode
    await page.getByTestId("pos-scan").fill("8909876543210");
    await page.getByTestId("pos-scan").press("Enter");

    await expect(page.getByText("Amul Butter 100g")).toBeVisible();

    // Check subtotal / total before discounts (25 + 56 = 81)
    await expect(page.getByTestId("pos-total")).toContainText("81.00");

    // Enter bill discount of ₹5.00
    await page.getByTestId("pos-bill-discount").fill("5.00");
    // Total should now be 76.00
    await expect(page.getByTestId("pos-total")).toContainText("76.00");

    // Quick cash button
    await page.getByTestId("pos-quick-100").click();
    await expect(page.getByTestId("pos-tendered")).toHaveValue("100");

    // Change banner: 100 - 76 = 24.00
    await expect(page.getByTestId("pos-change-banner")).toBeVisible();
    await expect(page.getByTestId("pos-change-banner")).toContainText("24.00");

    // Prevent auto-closing afterprint in headless browser
    await page.evaluate(() => {
      window.print = () => {};
    });

    // Save & print
    await page.getByTestId("pos-save-print").click();

    // Print view should open while printing (app-shell hides during print)
    await expect(page.getByTestId("print-view")).toBeVisible();
    await page.getByTestId("print-close").click();
    await expect(page.getByTestId("print-view")).not.toBeVisible();

    // After closing print preview, notice is visible in app-shell
    await expect(page.getByTestId("pos-notice")).toBeVisible();
    await expect(page.getByTestId("pos-notice")).toContainText("Saved bill");
  });

  test("handles split payment mode across multiple payment methods", async ({ page }) => {
    await ensureSetup(page);

    await createItem(page, {
      name: "Split Test Item",
      barcode: "8907778889990",
      price: "25.00",
      openingStock: "10",
    });

    await page.goto("/#/");
    await page.getByTestId("pos-scan").fill("8907778889990");
    await page.getByTestId("pos-scan").press("Enter");

    // Total is 25.00
    await expect(page.getByTestId("pos-total")).toContainText("25.00");

    // Click split payment
    await page.getByTestId("pos-mode-split").click();
    await expect(page.getByTestId("pos-split-form")).toBeVisible();

    // Fill split amounts: ₹15 cash + ₹10 UPI = ₹25
    await page.getByTestId("pos-split-cash").fill("15.00");
    await page.getByTestId("pos-split-upi").fill("10.00");

    // Save
    await page.getByTestId("pos-save").click();
    await expect(page.getByTestId("pos-notice")).toContainText("Saved bill");
  });
});
