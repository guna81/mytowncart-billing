// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";

export async function ensureSetup(page: Page, shopName = "Guna Kirana Store", gst = true) {
  await page.goto("/#/");
  const isSetup = await page
    .getByTestId("setup-shop-name")
    .isVisible({ timeout: 2500 })
    .catch(() => false);

  if (isSetup) {
    await page.getByTestId("setup-shop-name").fill(shopName);
    if (gst) {
      await page.getByTestId("setup-gst-yes").check();
    } else {
      await page.getByTestId("setup-gst-no").check();
    }
    await page.getByTestId("setup-start").click();
    await page.waitForSelector("[data-testid='pos-scan']");
  }
}

export async function createItem(
  page: Page,
  item: {
    name: string;
    barcode: string;
    price: string;
    costPrice?: string;
    hsnCode?: string;
    openingStock?: string;
  },
) {
  await page.goto("/#/items/new");
  await page.waitForSelector("[data-testid='item-name']");
  await page.getByTestId("item-name").fill(item.name);
  await page.getByTestId("item-barcode").fill(item.barcode);
  await page.getByTestId("item-price").fill(item.price);

  if (item.costPrice) {
    await page.getByTestId("item-cost-price").fill(item.costPrice);
  }
  if (item.hsnCode) {
    await page.getByTestId("item-hsn").fill(item.hsnCode);
  }
  if (item.openingStock) {
    await page.getByTestId("item-opening-stock").fill(item.openingStock);
  }

  await page.getByTestId("item-save").click();
  await page.waitForURL("/#/items");
}

export async function createCustomer(
  page: Page,
  customer: {
    name: string;
    phone: string;
    gstin?: string;
    address?: string;
  },
) {
  await page.goto("/#/customers");
  await page.getByTestId("customers-add").click();
  await page.waitForSelector("[data-testid='customer-name']");
  await page.getByTestId("customer-name").fill(customer.name);
  await page.getByTestId("customer-phone").fill(customer.phone);
  if (customer.gstin) {
    await page.getByTestId("customer-gstin").fill(customer.gstin);
  }
  if (customer.address) {
    await page.getByTestId("customer-address").fill(customer.address);
  }
  await page.getByTestId("customer-save").click();
  await page.waitForSelector("[data-testid='customer-dialog']", { state: "detached" });
}
