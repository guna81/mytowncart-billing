// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { ensureSetup } from "./helpers";

test.describe("Localisation Flow (Hindi & Tamil)", () => {
  test("switches between English, Hindi and Tamil locales dynamically", async ({ page }) => {
    await ensureSetup(page);

    // 1. Go to Settings
    await page.goto("/#/settings");
    await expect(page.getByTestId("lang-en")).toBeVisible();
    await expect(page.getByTestId("lang-hi")).toBeVisible();
    await expect(page.getByTestId("lang-ta")).toBeVisible();

    // 2. Switch to Hindi
    await page.getByTestId("lang-hi").click();
    await expect(page.getByText("बिलिंग")).toBeVisible();
    await expect(page.getByText("सामान (आइटम)")).toBeVisible();
    await expect(page.getByText("ग्राहक (खाता)")).toBeVisible();

    // 3. Switch to Tamil
    await page.getByTestId("lang-ta").click();
    await expect(page.getByText("பில்லிங்")).toBeVisible();
    await expect(page.getByText("பொருட்கள் (Items)")).toBeVisible();
    await expect(page.getByText("சரக்கு இருப்பு (Stock)")).toBeVisible();

    // 4. Switch back to English
    await page.getByTestId("lang-en").click();
    await expect(page.getByRole("link", { name: "Billing", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Items", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Customers", exact: true })).toBeVisible();
  });
});
