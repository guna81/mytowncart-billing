// SPDX-License-Identifier: Apache-2.0
/**
 * Hosted web app (D13): sign-in is mandatory, data survives a reload
 * (IndexedDB), backups are encrypted before upload, and a fresh browser
 * restores the shop from the cloud with the recovery key.
 */
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const API = "http://localhost:9000";
const SCOPES = ["products:write", "stock:write", "stock:read", "orders:read", "backups:write"];

interface Stored {
  id: string;
  bytes: Buffer;
  meta: Record<string, unknown>;
  createdAt: string;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
}

function wire(b: Stored) {
  return {
    id: b.id, size_bytes: b.bytes.length, sha256: b.meta.sha256, app_version: b.meta.app_version,
    schema_version: b.meta.schema_version, crypto_params: b.meta.crypto_params, created_at: b.createdAt,
  };
}

/** A fake MyTownCart: device flow + backups, shared across browser contexts. */
function fakeServer() {
  const backups: Stored[] = [];
  const pending = new Map<string, Record<string, unknown>>();
  const uploads: Buffer[] = [];
  let n = 0;

  async function install(context: BrowserContext) {
    await context.route(`${API}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname.replace("/api/v1/integrations", "");
      const method = req.method();
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (path === "/connect/start/") {
        return json(route, {
          device_code: "dev", user_code: "ABCD-EFGH", verification_url: `${API}/seller/connect?code=ABCD-EFGH`,
          expires_in: 600, interval: 1,
        }, 201);
      }
      if (path === "/connect/poll/") {
        return json(route, { token: "mtc_test", seller: { id: "s1", name: "Test Kirana", is_approved: true }, scopes: SCOPES });
      }
      if (path === "/me/") {
        return json(route, {
          seller: { id: "s1", name: "Test Kirana", is_approved: true }, scopes: SCOPES, api_version: "v1",
          min_billing_app_version: "0.0.1",
          limits: { bulk_max_items: 100, image_max_bytes: 5242880, min_poll_interval: 120, backup_max_bytes: 52428800 },
        });
      }
      if (path === "/backups/" && method === "GET") {
        return json(route, { results: [...backups].reverse().map(wire) });
      }
      if (path === "/backups/" && method === "POST") {
        const id = `b${++n}`;
        pending.set(id, req.postDataJSON() as Record<string, unknown>);
        return json(route, { id, upload_url: `${API}/api/v1/integrations/backups/${id}/blob/`, upload_method: "PUT" }, 201);
      }
      const blob = path.match(/^\/backups\/(b\d+)\/blob\/$/);
      if (blob && method === "PUT") {
        const bytes = req.postDataBuffer() ?? Buffer.alloc(0);
        uploads.push(bytes);
        const meta = pending.get(blob[1]!)!;
        expect(req.headers()["authorization"]).toBe("Bearer mtc_test");
        expect(bytes.length).toBe(meta.size_bytes);
        const stored = { id: blob[1]!, bytes, meta, createdAt: new Date().toISOString() };
        backups.push(stored);
        return json(route, wire(stored));
      }
      if (blob && method === "GET") {
        const found = backups.find((b) => b.id === blob[1]);
        return route.fulfill({ status: 200, contentType: "application/octet-stream", headers: cors, body: found!.bytes });
      }
      if (url.pathname.startsWith("/seller/connect")) {
        return route.fulfill({ status: 200, contentType: "text/html", body: "<p>approve</p>" });
      }
      return json(route, { message: "not mocked", code: "not_found" }, 404);
    });
  }

  return { install, backups, uploads };
}

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByTestId("hosted-signin").click();
  // The approval page opens in a new tab; the poll then returns the token.
}

async function confirmKey(page: Page): Promise<string> {
  const keyBox = page.getByTestId("hosted-key");
  await expect(keyBox).toBeVisible();
  const key = (await keyBox.textContent())!.trim();
  await page.getByTestId("hosted-key-confirm").fill(key);
  await page.getByTestId("hosted-key-ack").check();
  await page.getByTestId("hosted-key-continue").click();
  return key;
}

test("sign in, bill, back up encrypted, reload, and restore in a fresh browser", async ({ browser }) => {
  const server = fakeServer();

  // --- First browser: new shop ---------------------------------------------
  const first = await browser.newContext();
  await server.install(first);
  const page = await first.newPage();
  await signIn(page);
  const key = await confirmKey(page);
  expect(key).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);

  await page.getByTestId("setup-shop-name").fill("Hosted Test Store");
  await page.getByTestId("setup-gst-no").check();
  await page.getByTestId("setup-start").click();
  await expect(page.getByTestId("pos-scan")).toBeVisible();

  // Data is in IndexedDB: a reload goes straight back to the shop.
  await page.reload();
  await expect(page.getByTestId("pos-scan")).toBeVisible();

  // Back up now from Settings.
  await page.goto("/#/settings");
  await page.getByTestId("hosted-backup-now").click();
  await expect(page.getByTestId("hosted-last-backup")).not.toHaveText(/Not backed up/);
  expect(server.backups).toHaveLength(1);
  // The server never sees the shop's data in clear text.
  expect(server.uploads[0]!.includes(Buffer.from("Hosted Test Store"))).toBe(false);
  expect(server.uploads[0]!.subarray(0, 5).toString()).toBe("MTCB1");

  // A second tab of the same browser is refused (it would overwrite data).
  const second = await first.newPage();
  await second.goto("/");
  await expect(second.getByText(/Already open in another tab/)).toBeVisible();
  await first.close();

  // --- Fresh browser: restore from the cloud -------------------------------
  const fresh = await browser.newContext();
  await server.install(fresh);
  const page2 = await fresh.newPage();
  await signIn(page2);
  await expect(page2.getByTestId("hosted-restore")).toBeVisible();

  await page2.getByTestId("hosted-restore-key").fill("AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA");
  await page2.getByTestId("hosted-restore").click();
  await expect(page2.getByTestId("hosted-restore-error")).toContainText(/does not open/);

  await page2.getByTestId("hosted-restore-key").fill(key.toLowerCase());
  await page2.getByTestId("hosted-restore").click();
  await expect(page2.getByTestId("pos-scan")).toBeVisible();
  await page2.goto("/#/settings");
  await expect(page2.locator("body")).toContainText("Hosted Test Store");
  await fresh.close();
});

test("demo mode needs no sign-in and keeps nothing", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("hosted-demo").click();
  await expect(page.getByTestId("hosted-demo-banner")).toBeVisible();
  await expect(page.getByTestId("pos-scan")).toBeVisible();
  await page.getByRole("button", { name: "Exit demo" }).click();
  await expect(page.getByTestId("hosted-signin")).toBeVisible();
});
