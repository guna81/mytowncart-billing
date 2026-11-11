// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createItem, ensureSetup } from "./helpers";

test.describe("POS Add Customer Flow", () => {
  test("allows creating and auto-selecting a new customer directly from billing screen", async ({
    page,
  }) => {
    await ensureSetup(page);

    // Create a product to bill
    await createItem(page, {
      name: "Organic Coffee 250g",
      barcode: "8901234567895",
      price: "180.00",
      openingStock: "50",
    });

    // Go to POS billing screen
    await page.goto("/#/");
    await expect(page.getByTestId("pos-scan")).toBeVisible();

    // Scan the product
    await page.getByTestId("pos-scan").fill("8901234567895");
    await page.getByTestId("pos-scan").press("Enter");
    await expect(page.getByText("Organic Coffee 250g")).toBeVisible();

    // Customer should default to None
    await expect(page.getByTestId("pos-customer")).toHaveValue("");

    // 1. Verify "+ Add" button is present and opens customer dialog
    await expect(page.getByTestId("pos-add-customer-btn")).toBeVisible();
    await page.getByTestId("pos-add-customer-btn").click();
    await expect(page.getByTestId("customer-dialog")).toBeVisible();

    // Test cancelling dialog
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("customer-dialog")).not.toBeVisible();

    // 2. Open dialog via dropdown option ("+ Add Customer...")
    await page.getByTestId("pos-customer").selectOption({ value: "__add_new__" });
    await expect(page.getByTestId("customer-dialog")).toBeVisible();

    // Fill customer info
    await page.getByTestId("customer-name").fill("Aditi Rao");
    await page.getByTestId("customer-phone").fill("9845012345");
    await page.getByTestId("customer-gstin").fill("29ABCDE1234F1Z5");
    await page.getByTestId("customer-address").fill("42 MG Road, Bengaluru");

    // Save customer
    await page.getByTestId("customer-save").click();
    await expect(page.getByTestId("customer-dialog")).not.toBeVisible();

    // Verify auto-selection and confirmation notice
    await expect(page.getByTestId("pos-notice")).toBeVisible();
    await expect(page.getByTestId("pos-notice")).toContainText("Aditi Rao");

    // The customer dropdown should now have "Aditi Rao" selected
    const selectedText = await page.getByTestId("pos-customer").locator("option:checked").textContent();
    expect(selectedText?.trim()).toBe("Aditi Rao");

    // 3. Complete sale on Credit mode (which requires a customer)
    await page.getByTestId("pos-mode-credit").click();
    await page.getByTestId("pos-save").click();

    await expect(page.getByTestId("pos-notice")).toContainText("Saved bill");

    // 4. Verify customer and ledger on Customers screen
    await page.goto("/#/customers");
    await expect(page.getByText("Aditi Rao")).toBeVisible();
    await expect(page.getByText("9845012345")).toBeVisible();

    // Open ledger and verify outstanding balance is ₹180.00
    await page.getByRole("button", { name: "Ledger" }).click();
    await expect(page.getByTestId("customer-ledger-dialog")).toBeVisible();
    await expect(page.getByTestId("customer-outstanding-balance")).toContainText("180.00");
  });
});
