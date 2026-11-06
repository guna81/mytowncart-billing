// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createCustomer, createItem, ensureSetup } from "./helpers";

test.describe("Customer Credit & Ledger Flow", () => {
  test("links credit bill to customer, tracks ledger balance, and receives payment", async ({
    page,
  }) => {
    await ensureSetup(page);

    // Create item
    await createItem(page, {
      name: "Wheat Flour 5kg",
      barcode: "8901112223334",
      price: "240.00",
      openingStock: "20",
    });

    // Create customer with GSTIN & Address
    await createCustomer(page, {
      name: "Suresh Patel",
      phone: "9876543210",
      gstin: "29ABCDE1234F1Z5",
      address: "123 Main Bazaar, Town",
    });

    await expect(page.getByText("Suresh Patel")).toBeVisible();
    await expect(page.getByText("29ABCDE1234F1Z5")).toBeVisible();

    // Go to POS
    await page.goto("/#/");
    await page.getByTestId("pos-scan").fill("8901112223334");
    await page.getByTestId("pos-scan").press("Enter");
    await expect(page.getByText("Wheat Flour 5kg")).toBeVisible();

    // Switch payment mode to Credit
    await page.getByTestId("pos-mode-credit").click();

    // Try to save without selecting customer
    await page.getByTestId("pos-save").click();
    await expect(page.getByTestId("pos-notice")).toContainText(
      "A customer must be selected for credit sales",
    );

    // Select Suresh Patel
    await page.getByTestId("pos-customer").selectOption({ label: "Suresh Patel" });

    // Save now
    await page.getByTestId("pos-save").click();
    await expect(page.getByTestId("pos-notice")).toContainText("Saved bill");

    // Go to Customers screen
    await page.goto("/#/customers");
    await expect(page.getByText("Suresh Patel")).toBeVisible();

    // Open Ledger
    await page.getByRole("button", { name: "Ledger" }).click();
    await expect(page.getByTestId("customer-ledger-dialog")).toBeVisible();

    // Check outstanding balance: ₹240.00
    await expect(page.getByTestId("customer-outstanding-balance")).toContainText("240.00");
    // Check statement has the credit bill
    await expect(page.getByText(/Credit bill/)).toBeVisible();

    // Receive Payment of ₹100
    await page.getByTestId("customer-receive-payment").click();
    await expect(page.getByTestId("receive-payment-dialog")).toBeVisible();
    await page.getByTestId("customer-payment-amount").fill("100.00");
    await page.getByTestId("customer-payment-save").click();

    // Check updated outstanding balance: 240 - 100 = ₹140.00
    await expect(page.getByTestId("customer-outstanding-balance")).toContainText("140.00");

    // Close ledger
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("customer-ledger-dialog")).not.toBeVisible();

    // Try to delete customer with history (dialog confirm true)
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(
      page.getByText("Cannot delete this customer because they have bills or payment records"),
    ).toBeVisible();
  });
});
