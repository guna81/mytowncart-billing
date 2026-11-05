// SPDX-License-Identifier: Apache-2.0
/**
 * The MyTownCart implementation of `MarketplaceConnector` (roadmap §5.3/§8.4).
 *
 * Wire-format conversions live here and nowhere else (§8.2):
 *  - money: integer paise <-> decimal string ("12.50")
 *  - stock: integer units (the marketplace is integer-only, F1)
 *  - ids:   local item id <-> `itm_<id>` external id
 */

import { Http, MarketplaceError, type FetchLike } from "./http";
import type {
  ConnectSession,
  ConnectionToken,
  MarketplaceCategory,
  MarketplaceConnector,
  MarketplaceProfile,
  PublishItem,
  RemoteItem,
  RemoteOrder,
  Scope,
  StockPull,
  StockPush,
  StockPushResult,
  UpsertResult,
} from "./index";

/** Production defaults; the seller never types these (D12: no custom domain). */
export const DEFAULT_API_BASE_URL = "https://api.mytowncart.in/api/v1/integrations";
export const DEFAULT_WEB_BASE_URL = "https://mytowncart.in";
export const CONNECT_SCOPES: readonly Scope[] = ["catalog", "stock", "orders"];
const BULK_CHUNK = 100;

/** Scope strings the server understands (it has no `catalog` scope name). */
const SCOPE_NAMES: Record<Scope, string[]> = {
  catalog: ["products:write"],
  stock: ["stock:write", "stock:read"],
  orders: ["orders:read"],
  backups: ["backups:write"],
};

export function scopeNames(scopes: readonly Scope[]): string[] {
  return [...new Set(scopes.flatMap((s) => SCOPE_NAMES[s]))];
}

/** 1250 -> "12.50"; throws on non-integer input rather than rounding silently. */
export function paiseToDecimal(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new Error(`paise must be an integer, got ${paise}`);
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** "12.5" -> 1250; null when the server sends something unparseable. */
export function decimalToPaise(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const paise = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0") || 0);
  return m[1] === "-" ? -paise : paise;
}

interface StartResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface PollResponse {
  token: string;
  seller: { id: string; name: string; is_approved: boolean };
  scopes: string[];
}

interface CategoryPage {
  count: number;
  has_next: boolean;
  results: { id: string; name: string; parent: string | null; is_active: boolean }[];
}

interface MeResponse {
  seller: { id: string; name: string; is_approved: boolean };
  scopes: string[];
  min_billing_app_version: string;
  limits: { bulk_max_items: number; image_max_bytes: number; min_poll_interval: number };
}

interface BulkResponse {
  results: {
    external_id: string;
    status: UpsertResult["status"];
    product_id: string | null;
    variant_id: string | null;
    visible: boolean;
    error: string | null;
  }[];
}

interface ProductPage {
  has_next: boolean;
  results: {
    external_id: string;
    product_id: string;
    variant_id: string | null;
    price: string | null;
    stock: number | null;
    is_active: boolean;
    has_image: boolean;
  }[];
}

interface StockPushResponse {
  results: {
    external_id: string;
    status: "applied" | "duplicate" | "error";
    stock: number | null;
    clamped: boolean;
    error: string | null;
  }[];
}

interface StockFeedResponse {
  movements: {
    id: number;
    external_id: string;
    delta: number;
    reason: StockPull["reason"];
    created_at: string;
  }[];
  next_cursor: number;
}

interface OrdersResponse {
  orders: {
    id: string;
    status: string;
    payment_status: string;
    payment_method: string;
    total_price: string;
    created_at: string;
    updated_at: string;
    items: {
      external_id: string | null;
      product_name: string | null;
      quantity: number;
      price: string;
    }[];
  }[];
  next?: string;
}

export interface MyTownCartOptions {
  /** `.../api/v1/integrations` */
  apiBaseUrl: string;
  /** Shop origin; the public category list lives at `/api/v1/products/categories/`. */
  webBaseUrl: string;
  appVersion: string;
  /** Current token, or null when disconnected. */
  getToken?: () => string | null;
  /** Injected for tests; defaults to global fetch. */
  fetch?: FetchLike;
  /** Poll pacing override (tests); otherwise the server's `interval`/limits apply. */
  sleep?: (ms: number) => Promise<void>;
}

/** Client name the seller sees in the marketplace's connected-apps list. */
export const CLIENT_NAME = "MyTownCart Billing";

export class MyTownCartConnector implements MarketplaceConnector {
  private readonly http: Http;
  private readonly sleep: (ms: number) => Promise<void>;
  private minted: ConnectionToken | null = null;

  constructor(private readonly opts: MyTownCartOptions) {
    this.http = new Http({
      baseUrl: opts.apiBaseUrl,
      appVersion: opts.appVersion,
      fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
      token: () => opts.getToken?.() ?? null,
    });
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async connect(clientName: string, scopes: Scope[]): Promise<ConnectSession> {
    const start = await this.http.json<StartResponse>("POST", "/connect/start/", {
      client_name: clientName,
      scopes: scopeNames(scopes),
    });
    const deadline = Date.now() + start.expires_in * 1000;
    let intervalMs = Math.max(1, start.interval) * 1000;
    this.minted = null;

    return {
      userCode: start.user_code,
      verificationUrl: start.verification_url,
      waitForApproval: async () => {
        while (true) {
          if (Date.now() > deadline) {
            throw new MarketplaceError("expired_token", "This code expired. Start again.", 400);
          }
          await this.sleep(intervalMs);
          try {
            const polled = await this.http.json<PollResponse>("POST", "/connect/poll/", {
              device_code: start.device_code,
            });
            // The caller persists the token via takeMintedToken().
            this.minted = {
              token: polled.token,
              sellerName: polled.seller.name,
              sellerIsApproved: polled.seller.is_approved,
              scopes: polled.scopes,
            };
            return;
          } catch (err) {
            if (!(err instanceof MarketplaceError)) throw err;
            if (err.code === "authorization_pending") continue;
            if (err.code === "slow_down") {
              intervalMs += 5000;
              continue;
            }
            throw err;
          }
        }
      },
    };
  }

  /** The token minted by the most recent successful `waitForApproval()`. */
  takeMintedToken(): ConnectionToken | null {
    const minted = this.minted;
    this.minted = null;
    return minted;
  }

  async me(): Promise<MarketplaceProfile> {
    const me = await this.http.json<MeResponse>("GET", "/me/");
    return {
      sellerId: me.seller.id,
      sellerName: me.seller.name,
      sellerIsApproved: me.seller.is_approved,
      limits: {
        minPollIntervalSeconds: me.limits.min_poll_interval,
        bulkMaxItems: me.limits.bulk_max_items,
        imageMaxBytes: me.limits.image_max_bytes,
      },
      minBillingAppVersion: me.min_billing_app_version,
    };
  }

  async listCategories(): Promise<MarketplaceCategory[]> {
    const out: MarketplaceCategory[] = [];
    for (let page = 1; page <= 50; page++) {
      const categoriesUrl =
        `${this.opts.webBaseUrl.replace(/\/+$/, "")}/api/v1/products/categories/` +
        `?page=${page}&page_size=100`;
      const body = await this.categoriesPage(categoriesUrl);
      for (const c of body.results) {
        // Inactive categories cannot receive items (server rejects them).
        if (!c.is_active) continue;
        out.push({ id: c.id, name: c.name, parentId: c.parent });
      }
      if (!body.has_next) break;
    }
    return out;
  }

  private async categoriesPage(url: string): Promise<CategoryPage> {
    try {
      const response = await (this.opts.fetch ?? fetch)(url, {
        headers: { Accept: "application/json", "X-App-Version": this.opts.appVersion },
      });
      if (!response.ok) {
        throw new MarketplaceError("categories_unavailable", "Could not load marketplace categories.", response.status);
      }
      return (await response.json()) as CategoryPage;
    } catch (err) {
      if (err instanceof MarketplaceError) throw err;
      throw new MarketplaceError("network_error", err instanceof Error ? err.message : "Network request failed.", 0);
    }
  }

  async upsertItems(items: PublishItem[]): Promise<UpsertResult[]> {
    const out: UpsertResult[] = [];
    for (let i = 0; i < items.length; i += BULK_CHUNK) {
      const chunk = items.slice(i, i + BULK_CHUNK);
      const body = await this.http.json<BulkResponse>("POST", "/products/bulk-upsert/", {
        items: chunk.map((item) => ({
          external_id: item.externalId,
          name: item.name,
          category: item.categoryId,
          price: paiseToDecimal(item.pricePaise),
          // MRP below price is rejected by some marketplaces; only send when meaningful.
          ...(item.mrpPaise > item.pricePaise
            ? { old_price: paiseToDecimal(item.mrpPaise) }
            : {}),
          stock: item.stockUnits,
          ...(item.barcode ? { barcode: item.barcode } : {}),
          is_active: item.isActive,
        })),
      });
      out.push(
        ...body.results.map((r) => ({
          externalId: r.external_id,
          productId: r.product_id,
          variantId: r.variant_id,
          status: r.status,
          visible: r.visible,
          error: r.error,
        })),
      );
    }
    return out;
  }

  async uploadImage(externalId: string, file: Blob, isMain = false): Promise<void> {
    await this.http.upload(
      `/products/${encodeURIComponent(externalId)}/images/`,
      file,
      `${externalId}.jpg`,
      isMain ? { is_main: "true" } : undefined,
    );
  }

  async pushStock(moves: StockPush[]): Promise<StockPushResult[]> {
    const body = await this.http.json<StockPushResponse>("POST", "/stock/", {
      movements: moves.map((m) => ({
        external_id: m.externalId,
        delta: m.deltaUnits,
        idempotency_key: m.idempotencyKey,
        reason: m.reason,
      })),
    });
    // The server returns one result per movement, in request order.
    return moves.map((move, i) => {
      const found = body.results[i];
      return {
        idempotencyKey: move.idempotencyKey,
        status: found?.status ?? "error",
        clamped: found?.clamped ?? false,
        newStockUnits: found?.stock ?? null,
        error: found?.error ?? (found ? null : "The server did not report this move."),
      };
    });
  }

  async pullStock(cursor: number): Promise<{ moves: StockPull[]; nextCursor: number }> {
    const body = await this.http.json<StockFeedResponse>(
      "GET",
      `/stock/?cursor=${cursor}&limit=500`,
    );
    return {
      moves: body.movements.map((m) => ({
        id: m.id,
        externalId: m.external_id,
        deltaUnits: m.delta,
        reason: m.reason,
        createdAt: m.created_at,
      })),
      nextCursor: body.next_cursor,
    };
  }

  async pullOrders(after?: string): Promise<{ orders: RemoteOrder[]; next?: string }> {
    const qs = after ? `?after=${encodeURIComponent(after)}` : "";
    const body = await this.http.json<OrdersResponse>("GET", `/orders/${qs}`);
    return {
      orders: body.orders.map((o) => ({
        id: o.id,
        status: o.status,
        paymentStatus: o.payment_status,
        paymentMethod: o.payment_method,
        totalPaise: decimalToPaise(o.total_price) ?? 0,
        placedAt: o.created_at,
        updatedAt: o.updated_at,
        lines: o.items.map((i) => ({
          externalId: i.external_id,
          productName: i.product_name,
          qtyUnits: i.quantity,
          unitPricePaise: decimalToPaise(i.price) ?? 0,
        })),
      })),
      next: body.next,
    };
  }

  async listRemoteItems(): Promise<RemoteItem[]> {
    const out: RemoteItem[] = [];
    for (let page = 1; page <= 100; page++) {
      const body = await this.http.json<ProductPage>("GET", `/products/?page=${page}&page_size=100`);
      for (const p of body.results) {
        if (p.variant_id === null) continue;
        out.push({
          externalId: p.external_id,
          productId: p.product_id,
          variantId: p.variant_id,
          stockUnits: p.stock ?? 0,
          pricePaise: decimalToPaise(p.price) ?? 0,
          isActive: p.is_active,
        });
      }
      if (!body.has_next) break;
    }
    return out;
  }
}
