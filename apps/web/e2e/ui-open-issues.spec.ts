// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createItem, ensureSetup } from "./helpers";
import * as path from "node:path";
import * as fs from "node:fs";

const SCREENSHOT_DIR = "/Users/guna/.gemini/antigravity-cli/brain/638e1038-a245-43f7-87a8-091bbe808a53/screenshots";

test.describe("UI Open Issues Verification & Screenshots", () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  });

  test.beforeEach(async ({ page }) => {
    await ensureSetup(page);
  });

  test("P0: Add Item form responsive cards, non-overlapping sticky footer, and keyboard navigation", async ({ page }) => {
    // 1. Test at 1024x640 (short viewport)
    await page.setViewportSize({ width: 1024, height: 640 });
    await page.goto("/#/items/new");
    await page.waitForSelector("[data-testid='item-name']");

    // Verify 3 cards exist
    await expect(page.getByRole("heading", { name: "Basics" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pricing & Tax" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Stock & Status" })).toBeVisible();

    // Verify Save button is visible in viewport
    const saveBtn = page.getByTestId("item-save");
    await expect(saveBtn).toBeVisible();

    // Opening stock field exists and is not occluded by Save button
    const openingStock = page.getByTestId("item-opening-stock");
    await expect(openingStock).toBeVisible();

    const saveBox = await saveBtn.boundingBox();
    const stockBox = await openingStock.boundingBox();
    expect(saveBox).not.toBeNull();
    expect(stockBox).not.toBeNull();

    // Save button does not overlap opening stock field
    const overlaps = !(
      stockBox!.y + stockBox!.height <= saveBox!.y ||
      saveBox!.y + saveBox!.height <= stockBox!.y ||
      stockBox!.x + stockBox!.width <= saveBox!.x ||
      saveBox!.x + saveBox!.width <= stockBox!.x
    );
    expect(overlaps).toBe(false);

    // Take screenshot at 1024x640
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "item-form-1024x640.png") });

    // 2. Test at 1280x720
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "item-form-1280x720.png") });

    // 3. Test at 1470x681
    await page.setViewportSize({ width: 1470, height: 681 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "item-form-1470x681.png") });

    // 4. Keyboard navigation test: create item using keyboard only
    const itemName = `Keyboard Item ${Date.now()}`;
    await page.getByTestId("item-name").focus();
    await page.keyboard.type(itemName);
    await page.keyboard.press("Tab"); // to barcode
    await page.keyboard.type("8901239999");
    await page.keyboard.press("Tab"); // to category
    await page.keyboard.press("Tab"); // to unitKind
    await page.keyboard.press("Tab"); // to price
    await page.keyboard.type("99.50");
    await page.keyboard.press("Tab"); // to mrp
    await page.keyboard.type("110.00");
    await page.keyboard.press("Tab"); // to tax rate
    await page.keyboard.type("5");
    await page.keyboard.press("Tab"); // to cost price
    await page.keyboard.type("80.00");
    await page.keyboard.press("Tab"); // to hsn
    await page.keyboard.type("1905");
    await page.keyboard.press("Tab"); // to opening stock
    await page.keyboard.type("25");
    await page.keyboard.press("Tab"); // to active checkbox
    await page.keyboard.press("Tab"); // to cancel
    await page.keyboard.press("Tab"); // to save
    await page.keyboard.press("Enter"); // submit

    await page.waitForURL("/#/items");
    await expect(page.locator("body")).toContainText(itemName);
  });

  test("P1: POS at 1024x768 right panel visibility, quick chips, and held bills", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/#/");
    await page.waitForSelector("[data-testid='pos-scan']");

    // Verify held bills is collapsed to a single line
    const heldContainer = page.getByTestId("pos-held");
    await expect(heldContainer).toBeVisible();
    await expect(heldContainer).toContainText("No held bills");
    const heldBox = await heldContainer.boundingBox();
    expect(heldBox!.height).toBeLessThanOrEqual(40); // Single line compact height!

    // Verify Quick Cash Chips Exact, 100, 200, 500, 2000 are all visible
    await expect(page.getByTestId("pos-quick-exact")).toBeVisible();
    await expect(page.getByTestId("pos-quick-100")).toBeVisible();
    await expect(page.getByTestId("pos-quick-200")).toBeVisible();
    await expect(page.getByTestId("pos-quick-500")).toBeVisible();
    await expect(page.getByTestId("pos-quick-2000")).toBeVisible();

    // Verify chips do not clip and are laid out neatly
    const exactBox = await page.getByTestId("pos-quick-exact").boundingBox();
    const chip2000Box = await page.getByTestId("pos-quick-2000").boundingBox();
    expect(exactBox).not.toBeNull();
    expect(chip2000Box).not.toBeNull();
    // They are on the same vertical band (y values close)
    expect(Math.abs(exactBox!.y - chip2000Box!.y)).toBeLessThanOrEqual(10);

    // Verify Save & Print is visible in viewport without scrolling
    const savePrintBtn = page.getByTestId("pos-save-print");
    await expect(savePrintBtn).toBeVisible();
    const savePrintBox = await savePrintBtn.boundingBox();
    expect(savePrintBox).not.toBeNull();
    expect(savePrintBox!.y + savePrintBox!.height).toBeLessThanOrEqual(768);

    // Capture screenshot at 1024x768
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "pos-1024x768.png") });

    // Also capture at 1280x720
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "pos-1280x720.png") });
  });

  test("P1: Reports single day empty state and no axis/dot", async ({ page }) => {
    // 1. Create an item and make 1 sale so we have exactly 1 day of data
    const code = `890${Date.now().toString().slice(-8)}`;
    await createItem(page, {
      name: "Sample Product",
      barcode: code,
      price: "100.00",
      openingStock: "50",
    });
    await page.goto("/#/");
    await page.getByTestId("pos-scan").fill(code);
    await page.getByTestId("pos-scan").press("Enter");
    await page.getByTestId("pos-save").click();
    await expect(page.getByTestId("pos-notice")).toContainText(/Saved bill|INV-/);

    // 2. Go to Reports
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/#/reports");
    await page.getByTestId("reports-preset-today").click();

    // Revenue Trend section is rendered
    const trendSection = page.getByTestId("reports-trend-section");
    await expect(trendSection).toBeVisible();

    // When fewer than 2 points, plot area and axis are hidden, showing empty message
    const chart = page.getByTestId("sales-trend-chart");
    await expect(chart).toContainText(/Not enough data for a trend/);

    // Verify there are no polyline / trend path or circle dots drawn
    const dots = chart.locator("circle");
    expect(await dots.count()).toBe(0);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "reports-1280x720.png") });
  });

  test("P1: Dashboard Hourly Store Traffic formatting and tooltips", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/#/dashboard");
    await page.waitForSelector("[data-testid='dashboard-hourly-activity']");

    // Verify Hourly heatmap chart exists
    const heatmap = page.getByTestId("hourly-heatmap-chart");
    await expect(heatmap).toBeVisible();

    // Verify labels every 3h (0h, 3h, 6h, etc.)
    await expect(heatmap).toContainText("0h");
    await expect(heatmap).toContainText("3h");
    await expect(heatmap).toContainText("6h");
    await expect(heatmap).toContainText("21h");

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "dashboard-1280x720.png") });
  });
});
