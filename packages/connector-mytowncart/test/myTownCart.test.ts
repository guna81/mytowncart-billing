// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import type { PublishItem } from "../src/index";
import { MarketplaceError } from "../src/http";
import {
  MyTownCartConnector,
  decimalToPaise,
  paiseToDecimal,
  scopeNames,
} from "../src/myTownCart";

const API = "https://api.test/api/v1/integrations";
const WEB = "https://shop.test";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Queue of [matcher, response] pairs; every call is recorded. */
function fakeFetch(routes: [RegExp, () => Response][]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes.find(([re]) => re.test(url));
    if (!route) throw new Error(`unexpected request ${url}`);
    return route[1]();
  });
  return { fetch: fn, calls };
}

function connector(fetchFn: (url: string, init?: RequestInit) => Promise<Response>, token: string | null = "tok") {
  return new MyTownCartConnector({
    apiBaseUrl: API + "/",
    webBaseUrl: WEB,
    appVersion: "0.1.0",
    getToken: () => token,
    fetch: fetchFn,
    sleep: async () => {},
  });
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function headersOf(call: Call): Record<string, string> {
  return call.init?.headers as Record<string, string>;
}

describe("wire conversions", () => {
  it("formats paise as a two-decimal string without rounding", () => {
    expect(paiseToDecimal(0)).toBe("0.00");
    expect(paiseToDecimal(1250)).toBe("12.50");
    expect(paiseToDecimal(5)).toBe("0.05");
    expect(() => paiseToDecimal(1.5)).toThrow();
  });
  it("parses decimals back to paise", () => {
    expect(decimalToPaise("12.50")).toBe(1250);
    expect(decimalToPaise("12.5")).toBe(1250);
    expect(decimalToPaise("7")).toBe(700);
    expect(decimalToPaise(null)).toBeNull();
    expect(decimalToPaise("abc")).toBeNull();
  });
  it("maps app scopes to server scope names", () => {
    expect(scopeNames(["catalog", "stock", "orders"])).toEqual([
      "products:write",
      "stock:write",
      "stock:read",
      "orders:read",
    ]);
    expect(scopeNames(["catalog", "catalog"])).toEqual(["products:write"]);
  });
});

describe("connect", () => {
  it("polls through authorization_pending and slow_down, then mints once", async () => {
    let polls = 0;
    const { fetch } = fakeFetch([
      [
        /connect\/start\/$/,
        () =>
          jsonResponse(
            {
              device_code: "dc",
              user_code: "ABCD-EFGH",
              verification_url: "https://shop.test/seller/connect?code=ABCD-EFGH",
              expires_in: 600,
              interval: 1,
            },
            201,
          ),
      ],
      [
        /connect\/poll\/$/,
        () => {
          polls++;
          if (polls === 1) return jsonResponse({ code: "authorization_pending", message: "wait" }, 400);
          if (polls === 2) return jsonResponse({ code: "slow_down", message: "slow" }, 429);
          return jsonResponse({
            token: "secret-token",
            seller: { id: "s1", name: "Guna Stores", is_approved: false },
            scopes: ["products:write"],
          });
        },
      ],
    ]);
    const c = connector(fetch);
    const session = await c.connect("MyTownCart Billing", ["catalog"]);
    expect(session.userCode).toBe("ABCD-EFGH");
    expect(session.verificationUrl).toContain("code=ABCD-EFGH");

    await session.waitForApproval();
    expect(polls).toBe(3);
    expect(c.takeMintedToken()).toEqual({
      token: "secret-token",
      sellerName: "Guna Stores",
      sellerIsApproved: false,
      scopes: ["products:write"],
    });
    expect(c.takeMintedToken()).toBeNull();
  });

  it("sends the server scope names on start", async () => {
    const { fetch, calls } = fakeFetch([
      [
        /connect\/start\/$/,
        () => jsonResponse({ device_code: "d", user_code: "U", verification_url: "v", expires_in: 60, interval: 5 }, 201),
      ],
    ]);
    await connector(fetch).connect("MyTownCart Billing", ["catalog", "stock"]);
    expect(bodyOf(calls[0])).toEqual({
      client_name: "MyTownCart Billing",
      scopes: ["products:write", "stock:write", "stock:read"],
    });
  });

  it("surfaces a denial", async () => {
    const { fetch } = fakeFetch([
      [/connect\/start\/$/, () => jsonResponse({ device_code: "d", user_code: "U", verification_url: "v", expires_in: 60, interval: 1 }, 201)],
      [/connect\/poll\/$/, () => jsonResponse({ code: "access_denied", message: "denied" }, 400)],
    ]);
    const session = await connector(fetch).connect("x", ["catalog"]);
    await expect(session.waitForApproval()).rejects.toMatchObject({ code: "access_denied" });
  });
});

describe("me", () => {
  it("maps the profile and limits", async () => {
    const { fetch, calls } = fakeFetch([
      [
        /\/me\/$/,
        () =>
          jsonResponse({
            seller: { id: "s1", name: "Guna Stores", is_approved: true },
            scopes: ["products:write"],
            min_billing_app_version: "0.2.0",
            limits: { bulk_max_items: 100, image_max_bytes: 5242880, min_poll_interval: 120 },
          }),
      ],
    ]);
    const me = await connector(fetch).me();
    expect(me).toEqual({
      sellerId: "s1",
      sellerName: "Guna Stores",
      sellerIsApproved: true,
      minBillingAppVersion: "0.2.0",
      limits: { minPollIntervalSeconds: 120, bulkMaxItems: 100, imageMaxBytes: 5242880 },
    });
    expect(headersOf(calls[0])["X-App-Version"]).toBe("0.1.0");
    expect(headersOf(calls[0]).Authorization).toBe("Bearer tok");
  });

  it("throws a typed error carrying the server code", async () => {
    const { fetch } = fakeFetch([[/\/me\/$/, () => jsonResponse({ code: "expired_token", message: "gone" }, 401)]]);
    const err = await connector(fetch).me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketplaceError);
    expect(err).toMatchObject({ code: "expired_token", status: 401, message: "gone" });
  });
});

describe("listCategories", () => {
  it("pages the public category list and drops inactive categories", async () => {
    const { fetch, calls } = fakeFetch([
      [
        /categories\/\?page=1/,
        () =>
          jsonResponse({
            has_next: true,
            results: [
              { id: "c1", name: "Snacks", parent: null, is_active: true },
              { id: "cx", name: "Retired", parent: null, is_active: false },
            ],
          }),
      ],
      [/categories\/\?page=2/, () => jsonResponse({ has_next: false, results: [{ id: "c2", name: "Drinks", parent: "c1", is_active: true }] })],
    ]);
    const cats = await connector(fetch).listCategories();
    expect(cats).toEqual([
      { id: "c1", name: "Snacks", parentId: null },
      { id: "c2", name: "Drinks", parentId: "c1" },
    ]);
    expect(calls[0].url.startsWith(`${WEB}/api/v1/products/categories/`)).toBe(true);
  });

  it("falls back to apiBaseUrl origin when webBaseUrl points to the mytowncart.com frontend", async () => {
    const { fetch, calls } = fakeFetch([
      [
        /categories\/\?page=1/,
        () => jsonResponse({ has_next: false, results: [{ id: "c1", name: "Snacks", parent: null, is_active: true }] }),
      ],
    ]);
    const custom = new MyTownCartConnector({
      apiBaseUrl: "https://api.mytowncart.com/api/v1/integrations",
      webBaseUrl: "https://mytowncart.com",
      appVersion: "0.1.0",
      fetch,
    });
    const cats = await custom.listCategories();
    expect(cats).toEqual([{ id: "c1", name: "Snacks", parentId: null }]);
    expect(calls[0].url.startsWith("https://api.mytowncart.com/api/v1/products/categories/")).toBe(true);
  });
});

function publishItem(overrides: Partial<PublishItem> = {}): PublishItem {
  return {
    externalId: "itm_1",
    name: "Parle-G Biscuits 56g",
    pricePaise: 1000,
    mrpPaise: 1200,
    stockUnits: 120,
    barcode: "8901719101111",
    categoryId: "c1",
    isActive: true,
    contentHash: "h",
    ...overrides,
  };
}

describe("upsertItems", () => {
  it("sends the contract fields and maps results", async () => {
    const { fetch, calls } = fakeFetch([
      [
        /bulk-upsert\/$/,
        () =>
          jsonResponse({
            results: [
              { external_id: "itm_1", status: "created", product_id: "p1", variant_id: "v1", visible: false, error: null },
              { external_id: "itm_2", status: "error", product_id: null, variant_id: null, visible: false, error: "bad category" },
            ],
          }),
      ],
    ]);
    const results = await connector(fetch).upsertItems([
      publishItem(),
      publishItem({ externalId: "itm_2", name: "Soap", barcode: "", mrpPaise: 0 }),
    ]);
    const sent = bodyOf(calls[0]).items as Record<string, unknown>[];
    expect(sent[0]).toEqual({
      external_id: "itm_1",
      name: "Parle-G Biscuits 56g",
      category: "c1",
      price: "10.00",
      old_price: "12.00",
      stock: 120,
      barcode: "8901719101111",
      is_active: true,
    });
    // MRP <= price and an empty barcode are omitted, never sent as 0/"".
    expect(sent[1]).not.toHaveProperty("old_price");
    expect(sent[1]).not.toHaveProperty("barcode");
    expect(results).toEqual([
      { externalId: "itm_1", status: "created", productId: "p1", variantId: "v1", visible: false, error: null },
      { externalId: "itm_2", status: "error", productId: null, variantId: null, visible: false, error: "bad category" },
    ]);
  });

  it("chunks at 100 items", async () => {
    const { fetch, calls } = fakeFetch([
      [
        /bulk-upsert\/$/,
        () => jsonResponse({ results: [] }),
      ],
    ]);
    const items = Array.from({ length: 250 }, (_, i) => publishItem({ externalId: `itm_${i}` }));
    await connector(fetch).upsertItems(items);
    expect(calls).toHaveLength(3);
    expect((bodyOf(calls[0]).items as unknown[]).length).toBe(100);
    expect((bodyOf(calls[2]).items as unknown[]).length).toBe(50);
  });
});

describe("stock", () => {
  it("pushes external ids and pairs results in request order", async () => {
    const { fetch, calls } = fakeFetch([
      [
        /\/stock\/$/,
        () =>
          jsonResponse({
            results: [
              { external_id: "itm_1", status: "applied", stock: 119, clamped: false, error: null },
              { external_id: "itm_1", status: "error", stock: null, clamped: false, error: "No billing item with that external_id." },
            ],
          }),
      ],
    ]);
    const results = await connector(fetch).pushStock([
      { externalId: "itm_1", deltaUnits: -1, reason: "sale", idempotencyKey: "bill:7:1", createdAt: "2026-11-05T10:00:00+05:30" },
      { externalId: "itm_1", deltaUnits: -1, reason: "sale", idempotencyKey: "bill:7:2", createdAt: "2026-11-05T10:00:00+05:30" },
    ]);
    expect((bodyOf(calls[0]).movements as Record<string, unknown>[])[0]).toEqual({
      external_id: "itm_1",
      delta: -1,
      idempotency_key: "bill:7:1",
      reason: "sale",
    });
    expect(results.map((r) => r.status)).toEqual(["applied", "error"]);
    expect(results[0].newStockUnits).toBe(119);
    expect(results[1].error).toContain("No billing item");
  });

  it("pulls the feed with the cursor", async () => {
    const { fetch, calls } = fakeFetch([
      [
        /stock\/\?cursor=12&limit=500$/,
        () =>
          jsonResponse({
            movements: [
              { id: 13, external_id: "itm_1", delta: -2, reason: "online_order", resulting_stock: 3, created_at: "2026-11-05T10:00:00Z" },
            ],
            next_cursor: 13,
            has_more: false,
          }),
      ],
    ]);
    const out = await connector(fetch).pullStock(12);
    expect(out.nextCursor).toBe(13);
    expect(out.moves[0]).toMatchObject({ id: 13, externalId: "itm_1", deltaUnits: -2, reason: "online_order" });
    expect(calls[0].url).toContain("cursor=12");
  });

  it("appends force=1 when force is true", async () => {
    const { fetch, calls } = fakeFetch([
      [
        /stock\/\?cursor=5&limit=500&force=1$/,
        () => jsonResponse({ movements: [], next_cursor: 5 }),
      ],
    ]);
    await connector(fetch).pullStock(5, { force: true });
    expect(calls[0].url).toContain("force=1");
  });
});

describe("network failures", () => {
  it("becomes a network_error, never an unhandled throw", async () => {
    const { fetch } = fakeFetch([]);
    const err = await connector(fetch).me().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "network_error", status: 0 });
  });
});

describe("photos", () => {
  it("maps the main photo of each product, null when none", async () => {
    const { fetch } = fakeFetch([
      [
        /products\/\?page=1/,
        () =>
          jsonResponse({
            has_next: false,
            results: [
              { external_id: "itm_1", product_id: "p1", variant_id: "v1", price: "10.00", stock: 1, is_active: true, main_image: { id: "i1", url: "https://m.test/a.webp", uploaded_at: "2026-11-11T10:00:00+05:30" } },
              { external_id: "itm_2", product_id: "p2", variant_id: "v2", price: "10.00", stock: 1, is_active: true, main_image: null },
              { external_id: "itm_3", product_id: "p3", variant_id: "v3", price: "10.00", stock: 1, is_active: true },
            ],
          }),
      ],
    ]);
    const out = await connector(fetch).listRemoteItems();
    expect(out[0]?.mainImage).toEqual({ id: "i1", url: "https://m.test/a.webp", uploadedAt: "2026-11-11T10:00:00+05:30" });
    expect(out[1]?.mainImage).toBeNull();
    expect(out[2]?.mainImage).toBeUndefined(); // older server
  });

  it("downloads a photo without sending the token, and refuses insecure addresses", async () => {
    const { fetch, calls } = fakeFetch([[/m\.test\/a\.webp/, () => new Response(new Uint8Array([1, 2, 3]))]]);
    const c = connector(fetch);
    const bytes = await c.downloadImage("https://m.test/a.webp");
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(calls[0]?.init?.headers).toBeUndefined();
    await expect(c.downloadImage("http://m.test/a.webp")).rejects.toBeInstanceOf(MarketplaceError);
  });
});

describe("upsertItems — item groups", () => {
  const member = (id: string, size: string, price: number): PublishItem => ({
    externalId: id,
    name: `Tee – ${size}`,
    pricePaise: price,
    mrpPaise: 0,
    stockUnits: 5,
    barcode: null,
    categoryId: "cat1",
    isActive: true,
    contentHash: "h",
    group: { id: "grp_1", name: "Tee", options: { Size: size } },
  });
  const groupReply = () =>
    jsonResponse({
      results: [
        {
          external_id: "grp_1",
          status: "created",
          product_id: "p1",
          variant_id: "v1",
          variants: { itm_m: "v1", itm_l: "v2" },
          visible: true,
          error: null,
        },
      ],
    });

  it("sends a group as one product with variants and fans the result back out", async () => {
    const { fetch, calls } = fakeFetch([[/bulk-upsert/, groupReply]]);
    const c = new MyTownCartConnector({
      apiBaseUrl: API + "/", webBaseUrl: WEB, appVersion: "0.1.0",
      getToken: () => "tok", fetch, sleep: async () => {}, variantGroups: true,
    });
    const results = await c.upsertItems([member("itm_m", "M", 49900), member("itm_l", "L", 54900)]);
    expect(calls).toHaveLength(1);
    const sent = (bodyOf(calls[0]!).items as Record<string, unknown>[])[0]!;
    expect(sent.external_id).toBe("grp_1");
    expect(sent.name).toBe("Tee");
    expect((sent.variants as unknown[]).length).toBe(2);
    expect(results.map((r) => [r.externalId, r.productId, r.variantId])).toEqual([
      ["itm_m", "p1", "v1"],
      ["itm_l", "p1", "v2"],
    ]);
  });

  it("keeps each option a separate product when the flag is off", async () => {
    const { fetch, calls } = fakeFetch([
      [/bulk-upsert/, () => jsonResponse({ results: [
        { external_id: "itm_m", status: "created", product_id: "a", variant_id: "x", visible: true, error: null },
        { external_id: "itm_l", status: "created", product_id: "b", variant_id: "y", visible: true, error: null },
      ] })],
    ]);
    await connector(fetch).upsertItems([member("itm_m", "M", 49900), member("itm_l", "L", 54900)]);
    const sent = bodyOf(calls[0]!).items as Record<string, unknown>[];
    expect(sent.map((i) => i.external_id)).toEqual(["itm_m", "itm_l"]);
    expect(sent[0]).not.toHaveProperty("variants");
  });
});
