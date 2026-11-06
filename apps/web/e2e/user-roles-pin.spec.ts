// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { ensureSetup } from "./helpers";

test.describe("Users, Roles & PIN Lock Flow", () => {
  test("creates cashier and owner users, tests quick lock, invalid PIN and unlock", async ({ page }) => {
    await ensureSetup(page);

    // 1. Navigate to Users & Roles
    await page.goto("/#/users");
    await expect(page.getByTestId("users-add")).toBeVisible();

    // 2. Add Cashier user
    await page.getByTestId("users-add").click();
    await page.getByTestId("user-name").fill("Ramesh Cashier");
    await page.getByTestId("user-role").selectOption("cashier");
    await page.getByTestId("user-pin").fill("1234");
    await page.getByTestId("user-submit").click();

    await expect(page.getByText("Ramesh Cashier")).toBeVisible();
    await expect(page.getByText("Cashier", { exact: true })).toBeVisible();

    // 3. Add Owner user
    await page.getByTestId("users-add").click();
    await page.getByTestId("user-name").fill("Suresh Owner");
    await page.getByTestId("user-role").selectOption("owner");
    await page.getByTestId("user-pin").fill("8888");
    await page.getByTestId("user-submit").click();

    await expect(page.getByText("Suresh Owner")).toBeVisible();
    await expect(page.getByText("Store Owner", { exact: true })).toBeVisible();

    // 4. Test Terminal Quick Lock
    await page.getByTestId("sidebar-lock-btn").click();
    await expect(page.getByTestId("pin-lock-modal")).toBeVisible();

    // 5. Enter wrong PIN
    await page.getByTestId("pin-input").fill("0000");
    await page.getByTestId("pin-submit").click();
    await expect(page.getByText("Invalid PIN")).toBeVisible();

    // 6. Enter correct Cashier PIN
    await page.getByTestId("pin-input").fill("1234");
    await page.getByTestId("pin-submit").click();

    // Terminal unlocks
    await expect(page.getByTestId("pin-lock-modal")).toBeHidden();
    await expect(page.getByText("Ramesh Cashier (cashier)")).toBeVisible();
  });
});
