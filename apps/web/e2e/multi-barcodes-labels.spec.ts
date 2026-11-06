// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createItem, ensureSetup } from "./helpers";

test.describe("Phase 3: Multi-Barcodes, Sticker Generator & Shortcut Cheat Sheet", () => {
  test.beforeEach(async ({ page }) => {
    await ensureSetup(page);
  });

  test("adds secondary barcode with pack qty, scans in POS, previews labels, and toggles shortcuts help", async ({
    page,
  }) => {
    // 1. Create base item (e.g. Tata Salt 1kg single unit)
    const baseBarcode = `890${Date.now().toString().slice(-10)}`;
    const secBarcode = `CASE${Date.now().toString().slice(-8)}`;

    await createItem(page, {
      name: "Tata Salt 1kg Pack",
      barcode: baseBarcode,
      price: "28.00",
      openingStock: "100",
    });

    // 2. Navigate to Edit Screen for this item
    await page.goto("/#/items");
    await page.getByTestId("items-search").fill("Tata Salt");
    await expect(page.locator("table tbody tr").first()).toContainText("Tata Salt");
    await page.locator("table tbody tr").first().getByRole("link", { name: /Edit/i }).click();
    await expect(page.locator("h1")).toContainText(/Edit item/i);

    // 3. Add Secondary Barcode (Case of 12)
    await expect(page.getByTestId("item-secondary-barcodes")).toBeVisible();
    await page.getByTestId("secondary-barcode-input").fill(secBarcode);
    await page.getByTestId("secondary-pack-qty-input").fill("12");
    await page.getByTestId("secondary-label-input").fill("12-Pack Case");
    await page.getByTestId("secondary-barcode-add").click();

    // Verify secondary barcode appears in table
    await expect(page.getByTestId("item-secondary-barcodes")).toContainText(secBarcode);
    await expect(page.getByTestId("item-secondary-barcodes")).toContainText("12-Pack Case");

    // 4. Test POS Scan using the Secondary Barcode
    await page.goto("/#/");
    await page.getByTestId("pos-scan").fill(secBarcode);
    await page.getByTestId("pos-scan").press("Enter");

    // Line should have Tata Salt with quantity 12!
    await expect(page.locator("body")).toContainText("Tata Salt 1kg Pack");
    const qtyInput = page.locator("input[data-testid^='pos-qty-']");
    await expect(qtyInput).toHaveValue("12");

    // 5. Test Barcode Sticker Generator Screen
    await page.goto("/#/items/labels");
    await expect(page.locator("h1")).toContainText("Print Barcode Labels");

    // Verify barcode sheet preview is visible
    await expect(page.getByTestId("barcode-sheet-container")).toBeVisible();

    // Change layout and count
    await page.getByTestId("barcode-layout-select").selectOption("a4-30");
    await page.getByTestId("barcode-label-count").fill("6");

    // Verify 6 barcode labels are rendered
    await expect(page.getByTestId("barcode-label")).toHaveCount(6);
    await expect(page.getByTestId("print-labels-action")).toBeEnabled();

    // 6. Test Keyboard Shortcut Cheat Sheet modal
    // Click keyboard icon button in sidebar
    await page.getByTestId("sidebar-shortcuts-btn").click();
    await expect(page.getByTestId("keyboard-shortcuts-modal")).toBeVisible();
    await expect(page.getByTestId("keyboard-shortcuts-modal")).toContainText("Keyboard Shortcuts & Operator Help");
    await expect(page.getByTestId("keyboard-shortcuts-modal")).toContainText("F1");
    await expect(page.getByTestId("keyboard-shortcuts-modal")).toContainText("F2");
    await expect(page.getByTestId("keyboard-shortcuts-modal")).toContainText("F9");

    // Close shortcuts modal
    await page.getByTestId("shortcuts-modal-close").click();
    await expect(page.getByTestId("keyboard-shortcuts-modal")).not.toBeVisible();
  });
});
