// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createItem, ensureSetup } from "./helpers";

test.describe("Stock Audit & Reorder Shopping List Flow", () => {
  test("performs physical stock audit, applies discrepancies, and checks reorder list", async ({ page }) => {
    await ensureSetup(page);

    // 1. Create items
    await createItem(page, {
      name: "Fortune Sunflower Oil 1L",
      barcode: "8906007281010",
      price: "165.00",
      costPrice: "140.00",
      openingStock: "10",
    });

    await createItem(page, {
      name: "Maggi 2-Minute Noodles 70g",
      barcode: "8901058852388",
      price: "14.00",
      costPrice: "11.00",
      openingStock: "2", // Low stock item
    });

    // 2. Navigate to Stock Audit screen
    await page.goto("/#/stock-audit");
    await expect(page.getByTestId("audit-table")).toBeVisible();
    await expect(page.getByText("Fortune Sunflower Oil 1L")).toBeVisible();

    // 3. Enter physical count for Fortune Sunflower Oil (counted 12 on shelf, system stock was 10)
    const oilInput = page.locator("[data-testid^='audit-physical-input-']").first();
    await oilInput.fill("12");

    // Variance badge should show +2
    await expect(page.getByText("+2")).toBeVisible();
    await expect(page.getByTestId("audit-apply-btn")).toBeEnabled();

    // 4. Apply Discrepancies
    await page.getByTestId("audit-apply-btn").click();
    await expect(page.getByText(/Adjusted \d+ items in inventory/)).toBeVisible();

    // 5. Verify system stock is now 12
    await page.goto("/#/stock");
    await expect(page.getByText("Fortune Sunflower Oil 1L")).toBeVisible();
    await expect(page.getByText("12")).toBeVisible();

    // 6. Check Reorder Shopping List tab
    await page.goto("/#/stock-audit");
    await page.getByTestId("audit-tab-reorder").click();
    await expect(page.getByTestId("reorder-table")).toBeVisible();
    await expect(page.getByTestId("reorder-table")).toContainText("Maggi 2-Minute Noodles 70g");
    await expect(page.getByTestId("audit-export-reorder-btn")).toBeVisible();
    await expect(page.getByTestId("audit-print-reorder-btn")).toBeVisible();
  });
});
