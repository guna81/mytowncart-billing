// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createItem, ensureSetup } from "./helpers";

test.describe("Hold & Void Flow", () => {
  test("holds and resumes a bill, saves, and voids with reason", async ({ page }) => {
    await ensureSetup(page);

    await createItem(page, {
      name: "Tata Salt 1kg",
      barcode: "8901234123412",
      price: "28.00",
      openingStock: "50",
    });

    // Go to POS
    await page.goto("/#/");
    await page.getByTestId("pos-scan").fill("8901234123412");
    await page.getByTestId("pos-scan").press("Enter");
    await expect(page.getByText("Tata Salt 1kg")).toBeVisible();

    // Click Hold
    await page.getByTestId("pos-hold").click();
    await expect(page.getByText("Tata Salt 1kg")).not.toBeVisible();
    await expect(page.getByTestId("pos-held")).toContainText("1 item(s)");

    // Resume the bill
    await page.getByRole("button", { name: /1 item\(s\)/ }).click();
    await expect(page.getByText("Tata Salt 1kg")).toBeVisible();

    // Save bill
    await page.getByTestId("pos-save").click();
    await expect(page.getByTestId("pos-notice")).toContainText("Saved bill");

    // Go to Bills list
    await page.goto("/#/bills");
    await expect(page.getByText("Active")).toBeVisible();

    // Open Bill Detail
    await page.getByRole("link", { name: "View" }).first().click();

    // Void bill
    await page.getByTestId("bill-void").click();
    await page.getByTestId("void-reason").fill("Customer cancelled transaction");
    await page.getByTestId("void-confirm").click();

    // Verify Void status
    await expect(page.getByText("Voided on")).toBeVisible();
    await expect(page.getByText("Customer cancelled transaction")).toBeVisible();
  });
});
