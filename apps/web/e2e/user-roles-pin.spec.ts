// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { ensureSetup } from "./helpers";

test.describe("Users, Roles & PIN Lock Flow", () => {
  test("owner first, then cashier; login is required and the cashier cannot reach owner pages", async ({ page }) => {
    await ensureSetup(page);
    await page.goto("/#/users");
    await expect(page.getByTestId("users-add")).toBeVisible();

    // 1. A cashier cannot be the first user: an owner must exist.
    await page.getByTestId("users-add").click();
    await page.getByTestId("user-name").fill("Ramesh Cashier");
    await page.getByTestId("user-role").selectOption("cashier");
    await page.getByTestId("user-pin").fill("1234");
    await page.getByTestId("user-submit").click();
    await expect(page.getByText("at least one active owner")).toBeVisible();
    await page.getByRole("button", { name: /cancel/i }).first().click();

    // 2. Add the owner. From now on a PIN login is required, so the terminal locks.
    await page.getByTestId("users-add").click();
    await page.getByTestId("user-name").fill("Suresh Owner");
    await page.getByTestId("user-role").selectOption("owner");
    await page.getByTestId("user-pin").fill("8888");
    await page.getByTestId("user-submit").click();
    await expect(page.getByTestId("pin-lock-modal")).toBeVisible();

    // 3. Wrong PIN is refused; the owner PIN unlocks.
    await page.getByTestId("pin-input").fill("0000");
    await page.getByTestId("pin-submit").click();
    await expect(page.getByText("Invalid PIN")).toBeVisible();
    await page.getByTestId("pin-input").fill("8888");
    await page.getByTestId("pin-submit").click();
    await expect(page.getByTestId("pin-lock-modal")).toBeHidden();
    await expect(page.getByText("Suresh Owner (owner)")).toBeVisible();

    // 4. The owner adds a cashier.
    await page.getByTestId("users-add").click();
    await page.getByTestId("user-name").fill("Ramesh Cashier");
    await page.getByTestId("user-role").selectOption("cashier");
    await page.getByTestId("user-pin").fill("1234");
    await page.getByTestId("user-submit").click();
    await expect(page.getByText("Ramesh Cashier")).toBeVisible();

    // 5. Lock, log in as the cashier: owner pages are hidden and refused.
    await page.getByTestId("sidebar-lock-btn").click();
    await expect(page.getByTestId("pin-lock-modal")).toBeVisible();
    await page.getByTestId("pin-input").fill("1234");
    await page.getByTestId("pin-submit").click();
    await expect(page.getByTestId("pin-lock-modal")).toBeHidden();
    await expect(page.getByText("Ramesh Cashier (cashier)")).toBeVisible();
    await expect(page.locator('a[href="#/users"]')).toHaveCount(0);
    await page.goto("/#/users");
    await expect(page.getByTestId("owner-only")).toBeVisible();
  });
});
