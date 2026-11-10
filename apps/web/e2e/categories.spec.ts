// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "@playwright/test";
import { ensureSetup } from "./helpers";

test.describe("Product Categories Screen", () => {
  test.beforeEach(async ({ page }) => {
    await ensureSetup(page);
  });

  test("navigate to product categories screen from sidebar and items screen", async ({ page }) => {
    // 1. Check sidebar link (already on POS screen after ensureSetup)
    await page.waitForSelector("[data-testid='app-sidebar']");
    const sidebarLink = page.locator("a[href='#/categories']");
    await expect(sidebarLink).toBeVisible();
    await sidebarLink.click();
    await page.waitForURL("**/#/categories");
    await expect(page.getByTestId("categories-screen")).toBeVisible();

    // 2. Check items screen header link
    await page.goto("/#/items");
    const itemsCatBtn = page.getByTestId("items-categories");
    await expect(itemsCatBtn).toBeVisible();
    await itemsCatBtn.click();
    await page.waitForURL("**/#/categories");
    await expect(page.getByTestId("categories-screen")).toBeVisible();
  });

  test("add and edit a category from product categories screen", async ({ page }) => {
    await page.goto("/#/categories");
    await page.waitForSelector("[data-testid='categories-screen']");

    const catName = `Bakery ${Date.now()}`;

    // Click Add Category button
    await page.getByTestId("category-add-btn").click();
    await expect(page.getByTestId("category-modal")).toBeVisible();

    // Submit empty name -> error
    await page.getByTestId("category-modal-save").click();
    await expect(page.getByTestId("category-modal-error")).toBeVisible();

    // Fill valid category name and save
    await page.getByTestId("category-modal-name").fill(catName);
    await page.getByTestId("category-modal-save").click();

    // Modal should close and category should appear in table
    await expect(page.getByTestId("category-modal")).not.toBeVisible();
    await expect(page.getByText(catName)).toBeVisible();

    // Try adding duplicate category -> error
    await page.getByTestId("category-add-btn").click();
    await page.getByTestId("category-modal-name").fill(catName);
    await page.getByTestId("category-modal-save").click();
    await expect(page.getByTestId("category-modal-error")).toBeVisible();
    await page.getByText("Cancel").click();

    // Search filter works
    await page.getByTestId("categories-search").fill(catName);
    await expect(page.getByText(catName)).toBeVisible();
    await page.getByTestId("categories-search").fill("NonExistentCategoryXYZ");
    await expect(page.getByText(catName)).not.toBeVisible();
    await page.getByTestId("categories-search").clear();

    // Edit category
    const editBtn = page.locator(`tr:has-text("${catName}") button:has-text("Edit")`);
    await editBtn.click();
    await expect(page.getByTestId("category-modal")).toBeVisible();
    const updatedName = `${catName} Updated`;
    await page.getByTestId("category-modal-name").fill(updatedName);
    await page.getByTestId("category-modal-save").click();

    await expect(page.getByTestId("category-modal")).not.toBeVisible();
    await expect(page.getByText(updatedName)).toBeVisible();

    // Check newly added category is available in ItemFormScreen
    await page.goto("/#/items/new");
    await page.waitForSelector("[data-testid='item-name']");
    const option = page.locator(`select option:has-text("${updatedName}")`);
    await expect(option).toBeAttached();
  });
});
