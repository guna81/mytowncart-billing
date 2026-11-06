// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createItem, ensureSetup } from "./helpers";

test.describe("Returns & Credit Notes Flow", () => {
  test("creates a bill, issues a partial return credit note, and verifies stock restore", async ({ page }) => {
    await ensureSetup(page);

    // 1. Create an item with opening stock 10
    await createItem(page, {
      name: "Tata Tea Gold 250g",
      barcode: "8901052002345",
      price: "140.00",
      openingStock: "10",
    });

    // 2. Bill 3 units on POS
    await page.goto("/#/");
    await page.getByTestId("pos-scan").fill("8901052002345");
    await page.getByTestId("pos-scan").press("Enter");

    // Increase qty to 3
    const lineQty = page.locator("input[data-testid^='pos-qty-']").first();
    await lineQty.fill("3");
    await page.getByTestId("pos-save").click();
    await expect(page.getByTestId("pos-notice")).toContainText("Saved bill");

    // Stock should now be 7 (10 - 3)
    await page.goto("/#/stock");
    await expect(page.getByText("Tata Tea Gold 250g")).toBeVisible();
    await expect(page.locator("td[data-testid^='stock-']")).toContainText("7");

    // 3. Navigate to Bills and view the bill
    await page.goto("/#/bills");
    await page.getByText("View").first().click();
    await expect(page.getByTestId("bill-return")).toBeVisible();

    // 4. Open Return / Credit Note modal
    await page.getByTestId("bill-return").click();
    await expect(page.getByTestId("credit-note-modal")).toBeVisible();

    // Return 1 unit out of 3
    const returnQtyInput = page.locator("[data-testid^='return-qty-']").first();
    await returnQtyInput.fill("1");
    await page.getByTestId("return-reason").fill("Customer returned unopened pack");
    await expect(page.getByTestId("return-total")).toContainText("140.00");

    // Submit credit note
    await page.getByTestId("return-submit").click();
    await expect(page.getByTestId("credit-note-modal")).toBeHidden();
    await expect(page.getByTestId("bill-notice")).toContainText("created successfully");

    // 5. Verify Credit Note listed in bill history
    await expect(page.getByTestId("credit-notes-section")).toBeVisible();
    await expect(page.getByTestId("credit-notes-section")).toContainText("Customer returned unopened pack");
    await expect(page.getByTestId("credit-notes-section")).toContainText("₹140.00");

    // 6. Verify stock restored to 8 (7 + 1 returned)
    await page.goto("/#/stock");
    await expect(page.getByText("Tata Tea Gold 250g")).toBeVisible();
    await expect(page.locator("td[data-testid^='stock-']")).toContainText("8");
  });
});
