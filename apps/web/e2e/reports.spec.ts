// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createItem, ensureSetup } from "./helpers";

test.describe("Reports & Dashboard Flow", () => {
  test("generates sales and verifies dashboard KPIs & reports presets", async ({ page }) => {
    await ensureSetup(page);

    await createItem(page, {
      name: "Good Day Cashew 100g",
      barcode: "8905556667778",
      price: "35.00",
      openingStock: "5", // Low stock alert
    });

    // Make a sale
    await page.goto("/#/");
    await page.getByTestId("pos-scan").fill("8905556667778");
    await page.getByTestId("pos-scan").press("Enter");
    await page.getByTestId("pos-save").click();
    await expect(page.getByTestId("pos-notice")).toContainText("Saved bill");

    // Check Dashboard
    await page.goto("/#/dashboard");
    await expect(page.getByTestId("dashboard-today-sales")).toContainText("35.00");
    await expect(page.getByTestId("dashboard-today-bills")).toContainText("1");
    await expect(page.getByTestId("dashboard-payment-breakdown")).toBeVisible();
    await expect(page.getByTestId("dashboard-top-items")).toContainText("Good Day Cashew 100g");

    // Check Reports screen
    await page.goto("/#/reports");
    await expect(page.getByTestId("reports-summary")).toContainText("35.00");

    // Click presets
    await page.getByTestId("reports-preset-today").click();
    await expect(page.getByTestId("reports-summary")).toContainText("35.00");

    await page.getByTestId("reports-preset-this_month").click();
    await expect(page.getByTestId("reports-summary")).toContainText("35.00");

    // Export button is clickable
    await expect(page.getByTestId("reports-export-daily")).toBeVisible();
  });
});
