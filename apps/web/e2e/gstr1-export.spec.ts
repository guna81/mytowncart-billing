// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createCustomer, createItem, ensureSetup } from "./helpers";

test.describe("Phase 3: GSTR-1 Tax Filing Export & Trend Analytics", () => {
  test.beforeEach(async ({ page }) => {
    await ensureSetup(page);
  });

  test("renders sales trend chart and exports GSTR-1 tables (4A, 7, 9B, 12)", async ({
    page,
  }) => {
    // 1. Create B2B Customer with GSTIN
    const custName = `B2B Wholesale Traders ${Date.now().toString().slice(-4)}`;
    await createCustomer(page, {
      name: custName,
      phone: "9912345678",
      gstin: "33AAAAA0000A1Z5", // Tamil Nadu GSTIN
    });

    // 2. Create item with HSN code & tax rate
    const code = `890${Date.now().toString().slice(-10)}`;
    await createItem(page, {
      name: "Organic Basmati Rice 5kg",
      barcode: code,
      price: "450.00",
      hsnCode: "1006",
      openingStock: "100",
    });

    // 3. Bill this item to the B2B customer in POS
    await page.goto("/#/");
    await page.getByTestId("pos-scan").fill(code);
    await page.getByTestId("pos-scan").press("Enter");
    await page.getByTestId("pos-customer").selectOption({ label: custName });
    await page.getByTestId("pos-save").click();
    await expect(page.getByTestId("pos-notice")).toContainText(/INV-/);

    // 4. Navigate to Reports screen
    await page.goto("/#/reports");

    // Check Sales Trend Chart section exists and renders SVG curve
    await expect(page.getByTestId("reports-trend-section")).toBeVisible();
    await expect(page.getByTestId("reports-trend-section").locator("svg")).toBeVisible();

    // Check GSTR-1 Tax Filing section exists
    await expect(page.getByTestId("reports-gstr1-section")).toBeVisible();

    // 5. Check Table 4A (B2B Supplies with GSTIN)
    await expect(page.getByTestId("gstr1-b2b-btn")).toBeVisible();
    await expect(page.getByTestId("reports-gstr1-section")).toContainText("Table 4A");

    // Check Table 7 (B2C Small Supplies)
    await expect(page.getByTestId("gstr1-b2cs-btn")).toBeVisible();
    await expect(page.getByTestId("reports-gstr1-section")).toContainText("Table 7");

    // Check Table 9B (CDNR Credit Notes)
    await expect(page.getByTestId("gstr1-cdnr-btn")).toBeVisible();
    await expect(page.getByTestId("reports-gstr1-section")).toContainText("Table 9B");

    // Check Table 12 (HSN Summary of Outward Supplies)
    await expect(page.getByTestId("gstr1-hsn-btn")).toBeVisible();
    await expect(page.getByTestId("reports-gstr1-section")).toContainText("Table 12");

    // Trigger download for Table 4A and Table 12
    const downloadPromiseB2B = page.waitForEvent("download");
    await page.getByTestId("gstr1-b2b-btn").click();
    const downloadB2B = await downloadPromiseB2B;
    expect(downloadB2B.suggestedFilename().toLowerCase()).toContain("gstr1_b2b_");

    const downloadPromiseHsn = page.waitForEvent("download");
    await page.getByTestId("gstr1-hsn-btn").click();
    const downloadHsn = await downloadPromiseHsn;
    expect(downloadHsn.suggestedFilename().toLowerCase()).toContain("gstr1_hsn_");
  });
});
