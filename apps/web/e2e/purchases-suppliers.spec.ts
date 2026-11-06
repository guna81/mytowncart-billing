// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createItem, ensureSetup } from "./helpers";

test.describe("Purchases & Supplier Management Flow", () => {
  test("creates supplier, records purchase invoice, increases stock and verifies profit margins", async ({ page }) => {
    await ensureSetup(page);

    // 1. Create an item with cost price ₹80, selling price ₹100, opening stock 5
    await createItem(page, {
      name: "Aashirvaad Atta 5kg",
      barcode: "8901030001234",
      price: "100.00",
      costPrice: "80.00",
      openingStock: "5",
    });

    // 2. Add Supplier
    await page.goto("/#/suppliers");
    await page.getByTestId("suppliers-add").click();
    await page.getByTestId("supplier-name").fill("ITC Wholesale Distributor");
    await page.getByTestId("supplier-phone").fill("9876543210");
    await page.getByTestId("supplier-gstin").fill("33AAAAA0000A1Z5");
    await page.getByTestId("supplier-submit").click();

    await expect(page.getByText("ITC Wholesale Distributor")).toBeVisible();
    await expect(page.getByText("9876543210")).toBeVisible();

    // 3. Record Purchase Invoice
    await page.goto("/#/purchases");
    await page.getByTestId("purchases-new").click();

    await page.getByTestId("purchase-supplier").selectOption({ label: "ITC Wholesale Distributor" });
    await page.getByTestId("purchase-invoice-no").fill("ITC-2026-981");

    // Add item line
    await page.getByTestId("purchase-item-select").selectOption({ index: 1 });
    await page.getByTestId("purchase-qty").fill("10"); // Buy 10 units
    await page.getByTestId("purchase-cost").fill("75.00"); // Cost ₹75
    await page.getByTestId("purchase-add-line").click();

    // Submit purchase
    await page.getByTestId("purchase-submit").click();
    await page.waitForURL("/#/purchases");

    // Verify purchase listed
    await expect(page.getByText("ITC-2026-981")).toBeVisible();
    await expect(page.getByRole("cell", { name: "ITC Wholesale Distributor" })).toBeVisible();

    // 4. Verify Stock has increased by 10 (5 opening + 10 purchase = 15)
    await page.goto("/#/stock");
    await expect(page.getByText("Aashirvaad Atta 5kg")).toBeVisible();
    await expect(page.locator("td[data-testid^='stock-']")).toContainText("15");

    // 5. Make a sale of 2 units on POS
    await page.goto("/#/");
    await page.getByTestId("pos-scan").fill("8901030001234");
    await page.getByTestId("pos-scan").press("Enter");
    const lineQty = page.locator("input[data-testid^='pos-qty-']").first();
    await lineQty.fill("2");
    await page.getByTestId("pos-save").click();
    await expect(page.getByTestId("pos-notice")).toContainText("Saved bill");

    // 6. Verify Reports Profit & Margins
    await page.goto("/#/reports");
    await expect(page.getByTestId("reports-profit-section")).toBeVisible();
    await expect(page.getByTestId("reports-gross-profit")).toBeVisible();
    await expect(page.getByTestId("reports-margin-pct")).toBeVisible();
    await expect(page.getByTestId("reports-profit-table")).toContainText("Aashirvaad Atta 5kg");
  });
});
