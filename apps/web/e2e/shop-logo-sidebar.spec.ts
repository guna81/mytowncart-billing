// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { ensureSetup } from "./helpers";

test.describe("Shop Logo and Sidebar Collapse", () => {
  test("allows uploading a logo in Settings and preserves logo without breaking during sidebar shrink", async ({
    page,
  }) => {
    // Set viewport wide enough so sidebar starts expanded
    await page.setViewportSize({ width: 1400, height: 900 });
    await ensureSetup(page, "Test Supermarket");

    // 1. Initially default logo is displayed
    await page.goto("/#/settings");
    await page.waitForSelector("[data-testid='settings-logo-input']");
    const defaultLogo = page.getByTestId("sidebar-default-logo");
    await expect(defaultLogo).toBeVisible();

    // 2. Upload a shop logo
    const dummySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#2563eb"/></svg>`;
    await page.getByTestId("settings-logo-input").setInputFiles({
      name: "shop-logo.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(dummySvg),
    });

    // Preview appears in settings
    await expect(page.getByTestId("settings-logo-preview")).toBeVisible();

    // Save settings
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();

    // 3. Shop logo is now visible in the sidebar brand header
    const sidebarLogo = page.getByTestId("sidebar-shop-logo");
    await expect(sidebarLogo).toBeVisible();
    const boxBefore = await sidebarLogo.boundingBox();
    expect(boxBefore).not.toBeNull();
    expect(boxBefore!.width).toBeGreaterThanOrEqual(28);
    expect(boxBefore!.height).toBeGreaterThanOrEqual(28);

    // 4. Shrink / collapse sidebar
    const collapseBtn = page.getByTitle("Collapse sidebar");
    await collapseBtn.click();

    // The sidebar width shrinks to collapsed width (w-16 = 64px)
    const sidebar = page.getByTestId("app-sidebar");
    await page.waitForTimeout(300); // allow transition to complete
    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox!.width).toBeLessThanOrEqual(68);

    // Verify logo is STILL visible, sharp, and has not shrunk or broken
    await expect(sidebarLogo).toBeVisible();
    const boxCollapsed = await sidebarLogo.boundingBox();
    expect(boxCollapsed).not.toBeNull();
    expect(boxCollapsed!.width).toBeGreaterThanOrEqual(28);
    expect(boxCollapsed!.height).toBeGreaterThanOrEqual(28);

    // 5. Expand sidebar back
    const expandBtn = page.getByTitle("Expand sidebar");
    await expandBtn.click();
    await page.waitForTimeout(300);
    const sidebarExpandedBox = await sidebar.boundingBox();
    expect(sidebarExpandedBox!.width).toBeGreaterThan(200);
    await expect(sidebarLogo).toBeVisible();

    // 6. Remove logo in settings and save
    await page.getByTestId("settings-logo-remove").click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();

    // Defaults back to default logo
    await expect(page.getByTestId("sidebar-default-logo")).toBeVisible();
  });
});
