import { expect, test } from "@playwright/test";
import { ensureSetup } from "./helpers";

test("catalog pack and photo are saved locally; duplicate lookup and offline scan work", async ({ page }) => {
  await page.route("**/api/v1/products/categories/**", (route) => route.fulfill({ json: {
    count: 1, next: null, results: [{ id: "category-1", name: "Groceries", parent: null, is_active: true }],
  } }));
  await page.route("**/api/v1/integrations/catalog/**", (route) => route.fulfill({ json: {
    count: 1, next: null, results: [{ id: "catalog-1", display_name: "Butter 100 g", name: "Butter",
      variant_label: "100 g", barcode: "0890123456789", product_category: "category-1", category_name: "Groceries",
      brand_name: "Demo brand", description: "Exact 100 g pack", image: "https://catalog-assets.test/butter.png", updated_at: new Date().toISOString() }],
  } }));
  await page.route("https://catalog-assets.test/butter.png", (route) => route.fulfill({
    contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" },
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=", "base64"),
  }));
  await ensureSetup(page, "Catalog Test Shop", false);
  await page.evaluate(async () => {
    const path = "/src/lib/connection.ts";
    const { saveConnection } = await import(path);
    await saveConnection({ token: "local-test-token", sellerName: "Test Shop", sellerIsApproved: true, scopes: ["products:write"] });
    location.hash = "/items/new";
  });
  await page.getByLabel("Catalog name or barcode").fill("0890123456789");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Use this pack" }).click();
  await expect(page.getByTestId("item-name")).toHaveValue("Butter 100 g");
  await expect(page.getByTestId("item-barcode")).toHaveValue("0890123456789");
  await page.getByTestId("item-price").fill("60");
  await page.getByTestId("item-opening-stock").fill("12");
  await page.getByTestId("item-save").click();
  await page.waitForURL("**/#/items");
  const saved = await page.evaluate(async () => {
    const path = "/src/lib/repository.ts";
    const { getRepository } = await import(path);
    const repo = getRepository();
    const item = (await repo.listItems({ activeOnly: false }))[0];
    return { ...item, images: (await repo.listItemImages(item.id)).length };
  });
  expect(saved).toMatchObject({ catalogEntryId: "catalog-1", name: "Butter 100 g", stockMilli: 12000, pricePaise: 6000, images: 1 });
  await page.evaluate(() => { location.hash = "/items/new"; });
  await page.getByLabel("Catalog name or barcode").fill("0890123456789");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Use this pack" }).click();
  await page.waitForURL(`**/#/items/${saved.id}/edit`);
  await expect(page.getByTestId("item-price")).toHaveValue("60.00");
  await page.route("**/api/v1/**", (route) => route.abort());
  await page.evaluate(() => { location.hash = "/"; });
  await page.getByTestId("pos-scan").fill("0890123456789");
  await page.getByTestId("pos-scan").press("Enter");
  await expect(page.getByText("Butter 100 g", { exact: true }).first()).toBeVisible();
});
