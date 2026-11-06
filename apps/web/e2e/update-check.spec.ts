// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { ensureSetup } from "./helpers";

test.describe("Update check flow (web mode)", () => {
  test("hides update button in sidebar and shows settings updates controls", async ({ page }) => {
    await ensureSetup(page);

    // Update button should never be visible in sidebar in pure web mode
    await expect(page.getByTestId("update-available-btn")).not.toBeVisible();

    // Navigate to settings
    await page.goto("/#/settings");
    await expect(page.getByTestId("check-updates-btn")).toBeVisible();
    await expect(page.getByText("Back up shop data before upgrading.")).toBeVisible();

    // Clicking check updates in web mode does not crash or show false updates
    await page.getByTestId("check-updates-btn").click();
    await expect(page.getByTestId("update-available-btn")).not.toBeVisible();
  });
});
