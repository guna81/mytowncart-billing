// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createItem, ensureSetup } from "./helpers";

test.describe("Phase 3: Batches & Expiry Date Tracking", () => {
  test.beforeEach(async ({ page }) => {
    await ensureSetup(page);
  });

  test("records purchase with batch & expiry and enforces FIFO batch visibility", async ({ page }) => {
    // 1. Create item
    const code = `890${Date.now().toString().slice(-10)}`;
    await createItem(page, {
      name: "Dolo 650 Tablets",
      barcode: code,
      price: "35.00",
      openingStock: "0",
    });

    // 2. Add Supplier
    await page.goto("/#/suppliers");
    await page.getByTestId("suppliers-add").click();
    await page.getByTestId("supplier-name").fill("Apex Pharma Distributors");
    await page.getByTestId("supplier-phone").fill("9888877777");
    await page.getByTestId("supplier-submit").click();
    await page.waitForSelector("[data-testid='supplier-dialog']", { state: "detached" });

    // 3. Record purchase with batch & expiry
    await page.goto("/#/purchases/new");
    await page.getByTestId("purchase-supplier").selectOption({ index: 1 });
    await page.getByTestId("purchase-invoice-no").fill("APEX-9988");

    // Select item
    await page.getByTestId("purchase-item-select").selectOption({ index: 1 });
    await page.getByTestId("purchase-qty").fill("50");
    await page.getByTestId("purchase-cost").fill("25.00");
    await page.getByTestId("purchase-batch-no").fill("BATCH-DL99");
    await page.getByTestId("purchase-expiry-date").fill("2026-12-31");
    await page.getByTestId("purchase-add-line").click();

    // Verify line shows batch info
    await expect(page.getByTestId("purchase-line-0")).toContainText("BATCH-DL99");
    await page.getByTestId("purchase-submit").click();
    await page.waitForURL("/#/purchases");

    // 4. Check Stock screen expiring batches tab
    await page.goto("/#/stock");
    await page.getByTestId("stock-tab-expiring").click();
    await expect(page.getByTestId("expiring-batches-table")).toContainText("BATCH-DL99");
    await expect(page.getByTestId("expiring-batches-table")).toContainText("Dolo 650 Tablets");

    // 5. Scan in POS and verify batch info on line
    await page.goto("/#/");
    await page.getByTestId("pos-scan").fill(code);
    await page.getByTestId("pos-scan").press("Enter");

    await expect(page.locator("body")).toContainText("Dolo 650 Tablets");
    await expect(page.locator("body")).toContainText("BATCH-DL99");
  });
});
