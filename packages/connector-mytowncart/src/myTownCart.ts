// SPDX-License-Identifier: Apache-2.0
import type { SharedCatalogPage } from "./index";
/**
 * The MyTownCart implementation of `MarketplaceConnector` (roadmap §5.3/§8.4).
 *
 * Wire-format conversions live here and nowhere else (§8.2):
 *  - money: integer paise <-> decimal string ("12.50")
 *  - stock: integer units (the marketplace is integer-only, F1)
 *  - ids:   local item id <-> `itm_<id>` external id
 */

import { Http, MarketplaceError, retryAfterSeconds, type FetchLike } from "./http";
import type {
  CloudBackup,
  CloudBackupMeta,
  BackupKeySetting,
  ConnectSession,
  ConnectionToken,
  OAuthTokenResult,
  MarketplaceCategory,
  MarketplaceConnector,
  MarketplaceProfile,
  PublishItem,
  AdoptResult,
  PlatformProduct,
  RemoteItem,
  RemoteProductImage,
  Scope,
  StockPull,
  StockPush,
  StockPushResult,
  StockFeed,
  StockPullOptions,
  StockSnapshot,
  StockSnapshotItem,
  StockReconcileRequest,
  StockReconcileResult,
  UpsertResult,
} from "./index";

/** Production defaults (used in production builds; D12: no custom domain). */
export const DEFAULT_API_BASE_URL = "https://api.mytowncart.com/api/v1/integrations";
export const DEFAULT_WEB_BASE_URL = "https://api.mytowncart.com";

/** Local development defaults. */
export const DEV_API_BASE_URL = "http://localhost:9000/api/v1/integrations";
export const DEV_WEB_BASE_URL = "http://localhost:4000";
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

interface Pagination {
  next?: string | null;
  has_next?: boolean;
}

function hasNextPage(body: Pagination): boolean {
  return body.next !== undefined ? body.next !== null && body.next !== "" : body.has_next === true;
}

interface CategoryPage extends Pagination {
  count: number;
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
    /** Item groups only: billing variant external_id → marketplace variant id. */
    variants?: Record<string, string>;
    visible: boolean;
    error: string | null;
  }[];
}

interface ProductPage extends Pagination {
  results: {
    external_id: string;
    external_source?: string;
    name?: string;
    category_name?: string;
    description?: string;
    main_image?: { id: string; url: string; uploaded_at: string } | null;
    product_id: string;
    variant_id: string | null;
    variant_count?: number;
    variants?: {
      variant_id: string;
      external_id: string;
      price: string;
      stock: number;
      is_active: boolean;
    }[];
    price: string | null;
    stock: number | null;
    is_active: boolean;
    has_image: boolean;
  }[];
}

interface AdoptResponse {
  results: {
    external_id: string;
    status: AdoptResult["status"];
    product_id: string | null;
    variant_id: string | null;
    visible: boolean;
    error: string | null;
  }[];
}

interface StockPushResponse {
  results: {
    external_id: string;
    status: "applied" | "duplicate" | "error";
    stock: number | null;
    clamped: boolean | null;
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
    sequence?: number;
    revision?: number;
  }[];
  next_cursor: number;
  has_more?: boolean;
  continuation?: string | null;
  epoch?: string;
  watermark?: number;
}

interface StockSnapshotWireItem {
  external_id: string;
  variant_id: string;
  stock: number;
  revision: number;
  generation: number;
}

interface StockSnapshotWire {
  epoch: string;
  watermark: number;
  items: StockSnapshotWireItem[];
}

interface StockReconcileWire extends StockSnapshotWireItem {
  operation_id: string;
  epoch: string;
  watermark: number;
  status: "applied";
}

function stockInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MarketplaceError("invalid_response", `Invalid ${label} in stock protocol response.`, 502);
  }
  return value;
}

function stockIdentity(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MarketplaceError("invalid_response", `Missing ${label} in stock protocol response.`, 502);
  }
  return value;
}

function snapshotItem(item: StockSnapshotWireItem): StockSnapshotItem {
  return {
    externalId: stockIdentity(item.external_id, "external ID"),
    variantId: stockIdentity(item.variant_id, "variant ID"),
    stockUnits: stockInteger(item.stock, "stock"),
    revision: stockInteger(item.revision, "revision"),
    generation: stockInteger(item.generation, "generation"),
  };
}

function snapshot(body: StockSnapshotWire, requested: readonly string[]): StockSnapshot {
  if (!Array.isArray(body.items)) {
    throw new MarketplaceError("invalid_response", "Unsupported stock snapshot response.", 502);
  }
  const items = body.items.map(snapshotItem);
  const ids = new Set(items.map((item) => item.externalId));
  if (ids.size !== items.length || ids.size !== requested.length || requested.some((id) => !ids.has(id))) {
    throw new MarketplaceError("invalid_response", "Stock snapshot did not identify every requested item exactly once.", 502);
  }
  return { epoch: stockIdentity(body.epoch, "epoch"), watermark: stockInteger(body.watermark, "watermark"), items };
}

function reconciliationResult(body: StockReconcileWire, operationId: string): StockReconcileResult {
  if (body.status !== "applied" || body.operation_id !== operationId) {
    throw new MarketplaceError("invalid_response", "Stock reconciliation returned an unexpected operation.", 502);
  }
  return { ...snapshotItem(body), operationId, epoch: stockIdentity(body.epoch, "epoch"), watermark: stockInteger(body.watermark, "watermark") };
}

export interface MyTownCartOptions {
  /** `.../api/v1/integrations` */
  apiBaseUrl: string;
  /** Shop origin; the public category list lives at `/api/v1/products/categories/`. */
  webBaseUrl: string;
  appVersion: string;
  /** Current token, or null when disconnected. */
  getToken?: () => string | null;
  /** Called on HTTP 401; return `true` after refreshing the token to retry once. */
  onUnauthorized?: (failedToken: string | null) => Promise<boolean>;
  /** Injected for tests; defaults to global fetch. */
  fetch?: FetchLike;
  /** Poll pacing override (tests); otherwise the server's `interval`/limits apply. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Send item groups as one product with variants (needs a server with
   * INTEGRATIONS_VARIANTS_ENABLED). Off = every option is its own product.
   */
  variantGroups?: boolean;
}

/** Client name the seller sees in the marketplace's connected-apps list. */
export const CLIENT_NAME = "MyTownCart Billing";

interface OAuthTokenWire {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function parseOAuthToken(wire: OAuthTokenWire): OAuthTokenResult {
  return {
    accessToken: wire.access_token,
    refreshToken: wire.refresh_token || undefined,
    expiresIn: typeof wire.expires_in === "number" && wire.expires_in > 0 ? wire.expires_in : 3600,
    scopes: typeof wire.scope === "string" && wire.scope.trim() !== "" ? wire.scope.trim().split(/\s+/) : [],
  };
}

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
      onUnauthorized: opts.onUnauthorized,
    });
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** RFC 7591 dynamic public client registration for OAuth 2.1 + PKCE. */
  async registerOAuthClient(clientName: string, redirectUri: string): Promise<{ clientId: string }> {
    const res = await this.http.json<{ client_id: string }>(
      "POST",
      "/oauth/register/",
      {
        client_name: clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      },
      { auth: false },
    );
    return { clientId: res.client_id };
  }

  /** Build the GET /oauth/authorize/ URL for a browser redirect. */
  buildOAuthAuthorizeUrl(params: {
    clientId: string;
    redirectUri: string;
    scopes: readonly Scope[];
    state: string;
    codeChallenge: string;
  }): string {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      scope: scopeNames(params.scopes).join(" "),
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${this.http.url("/oauth/authorize/")}?${query.toString()}`;
  }

  /** Exchange an OAuth authorization code + PKCE verifier for access/refresh tokens. */
  async exchangeOAuthCode(params: {
    clientId: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<OAuthTokenResult> {
    const wire = await this.http.json<OAuthTokenWire>(
      "POST",
      "/oauth/token/",
      {
        grant_type: "authorization_code",
        client_id: params.clientId,
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
      },
      { auth: false },
    );
    return parseOAuthToken(wire);
  }

  /** Rotate an OAuth refresh token for a fresh access/refresh token pair. */
  async refreshOAuthToken(params: {
    clientId: string;
    refreshToken: string;
  }): Promise<OAuthTokenResult> {
    const wire = await this.http.json<OAuthTokenWire>(
      "POST",
      "/oauth/token/",
      {
        grant_type: "refresh_token",
        client_id: params.clientId,
        refresh_token: params.refreshToken,
      },
      { auth: false },
    );
    return parseOAuthToken(wire);
  }

  /** Best-effort RFC 7009 token revocation on sign-out. */
  async revokeOAuthToken(params: { clientId: string; token: string }): Promise<void> {
    await this.http.json(
      "POST",
      "/oauth/revoke/",
      { client_id: params.clientId, token: params.token },
      { auth: false },
    );
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

  async searchSharedCatalog(search: string, page = 1): Promise<SharedCatalogPage> {
    const params = new URLSearchParams({ kind: "product", search: search.trim(), page: String(page) });
    return this.http.json<SharedCatalogPage>("GET", `/catalog/?${params}`);
  }

  async listCategories(): Promise<MarketplaceCategory[]> {
    const out: MarketplaceCategory[] = [];
    const base = this.categoriesBaseUrl();
    for (let page = 1; page <= 50; page++) {
      const categoriesUrl =
        `${base.replace(/\/+$/, "")}/api/v1/products/categories/` +
        `?page=${page}&page_size=100`;
      const body = await this.categoriesPage(categoriesUrl);
      for (const c of body.results) {
        // Inactive categories cannot receive items (server rejects them).
        if (!c.is_active) continue;
        out.push({ id: c.id, name: c.name, parentId: c.parent });
      }
      if (!hasNextPage(body)) return out;
      if (page === 50) throw new Error("Marketplace categories exceed the 50-page pagination limit.");
    }
    return out;
  }

  private categoriesBaseUrl(): string {
    // Categories endpoint lives on the API backend (/api/v1/products/categories/).
    return this.opts.apiBaseUrl
      .replace(/\/integrations\/?$/, "")
      .replace(/\/api\/v1\/?$/, "");
  }

  private async categoriesPage(url: string): Promise<CategoryPage> {
    try {
      const response = await (this.opts.fetch ?? fetch)(url, {
        headers: { Accept: "application/json", "X-App-Version": this.opts.appVersion },
      });
      if (!response.ok) {
        throw new MarketplaceError("categories_unavailable", `Could not load marketplace categories (HTTP ${response.status} from ${url}).`, response.status, retryAfterSeconds(response));
      }
      return (await response.json()) as CategoryPage;
    } catch (err) {
      if (err instanceof MarketplaceError) throw err;
      throw new MarketplaceError("network_error", err instanceof Error ? err.message : "Network request failed.", 0);
    }
  }

  /** Wire shape of one item group: a product whose variants are its options. */
  private groupWire(members: PublishItem[]) {
    const first = members[0]!;
    return {
      external_id: first.group!.id,
      name: first.group!.name,
      category: first.categoryId,
      is_active: members.some((m) => m.isActive),
      ...(first.description ? { description: first.description } : {}),
      ...(first.brand ? { brand: first.brand } : {}),
      ...(first.customAttributes && Object.keys(first.customAttributes).length > 0
        ? { attributes: first.customAttributes }
        : {}),
      variants: members.map((m) => ({
        external_id: m.externalId,
        price: paiseToDecimal(m.pricePaise),
        ...(m.mrpPaise > m.pricePaise ? { old_price: paiseToDecimal(m.mrpPaise) } : {}),
        stock: m.stockUnits,
        ...(m.barcode ? { barcode: m.barcode } : {}),
        is_active: m.isActive,
        options: m.group!.options,
      })),
    };
  }

  async upsertItems(items: PublishItem[]): Promise<UpsertResult[]> {
    if (!this.opts.variantGroups || !items.some((i) => i.group)) return this.upsertPlain(items);
    const groups = new Map<string, PublishItem[]>();
    const plain: PublishItem[] = [];
    for (const item of items) {
      if (!item.group) plain.push(item);
      else groups.set(item.group.id, [...(groups.get(item.group.id) ?? []), item]);
    }
    const out = await this.upsertPlain(plain);
    const entries = [...groups.entries()];
    for (let i = 0; i < entries.length; i += BULK_CHUNK) {
      const chunk = entries.slice(i, i + BULK_CHUNK);
      const body = await this.http.json<BulkResponse>("POST", "/products/bulk-upsert/", {
        items: chunk.map(([, members]) => this.groupWire(members)),
      });
      const byGroup = new Map(body.results.map((r) => [r.external_id, r]));
      for (const [groupId, members] of chunk) {
        const r = byGroup.get(groupId);
        for (const m of members) {
          out.push({
            externalId: m.externalId,
            productId: r?.product_id ?? null,
            variantId: r?.variants?.[m.externalId] ?? null,
            status: r ? r.status : "error",
            visible: r?.visible ?? false,
            error: r ? r.error : "No result returned for this item group.",
          });
        }
      }
    }
    return out;
  }

  private async upsertPlain(items: PublishItem[]): Promise<UpsertResult[]> {
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
          ...(item.description
            ? { description: item.description }
            : item.clearDescription
              ? { description: "" }
              : {}),
          ...(item.brand ? { brand: item.brand } : {}),
          ...(item.catalogEntryId ? { catalog_entry_id: item.catalogEntryId } : {}),
          ...(item.customAttributes && Object.keys(item.customAttributes).length > 0
            ? { attributes: item.customAttributes }
            : {}),
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

  async uploadImage(
    externalId: string,
    file: Blob,
    isMain = false,
  ): Promise<{ imageId: string; isMain: boolean; isActive: boolean }> {
    const res = await this.http.upload<{ image_id: string; is_main: boolean; is_active: boolean }>(
      `/products/${encodeURIComponent(externalId)}/images/`,
      file,
      `${externalId}.jpg`,
      isMain ? { is_main: "true" } : undefined,
    );
    return {
      imageId: res?.image_id,
      isMain: Boolean(res?.is_main),
      isActive: Boolean(res?.is_active),
    };
  }

  async downloadImage(url: string): Promise<Uint8Array> {
    return this.http.download(url, 10 * 1024 * 1024);
  }

  async deleteImage(externalId: string, imageId?: string): Promise<void> {
    const qs = imageId ? `?image_id=${encodeURIComponent(imageId)}` : "";
    await this.http.json("DELETE", `/products/${encodeURIComponent(externalId)}/images/${qs}`);
  }

  async listImages(externalId: string): Promise<RemoteProductImage[]> {
    const res = await this.http.json<{ images: RemoteProductImage[] }>(
      "GET",
      `/products/${encodeURIComponent(externalId)}/images/`,
    );
    return res?.images ?? [];
  }

  async pushStock(moves: StockPush[]): Promise<StockPushResult[]> {
    const body = await this.http.json<StockPushResponse>("POST", "/stock/", {
      movements: moves.map((m) => ({
        external_id: m.externalId,
        delta: m.deltaUnits,
        idempotency_key: m.idempotencyKey,
        reason: m.reason === "sale" ? "pos_sale" : m.reason,
        ...(m.epoch === undefined ? {} : { epoch: m.epoch }),
        ...(m.variantId === undefined ? {} : { variant_id: m.variantId }),
        ...(m.generation === undefined ? {} : { generation: m.generation }),
      })),
    });
    // The server returns one result per movement, in request order.
    return moves.map((move, i) => {
      const found = body.results[i];
      return {
        idempotencyKey: move.idempotencyKey,
        status: found?.status ?? "error",
        clamped: found?.clamped ?? null,
        newStockUnits: found?.stock ?? null,
        error: found?.error ?? (found ? null : "The server did not report this move."),
      };
    });
  }

  async stockSnapshot(externalIds: string[]): Promise<StockSnapshot> {
    const body = await this.http.json<StockSnapshotWire>("POST", "/stock/snapshot/", { external_ids: externalIds });
    return snapshot(body, externalIds);
  }

  async reconcileStock(request: StockReconcileRequest): Promise<StockReconcileResult> {
    const body = await this.http.json<StockReconcileWire>("POST", "/stock/reconcile/", {
      operation_id: request.operationId,
      external_id: request.externalId,
      variant_id: request.variantId,
      epoch: request.epoch,
      expected_revision: request.expectedRevision,
      generation: request.generation,
      quantity: request.quantity,
    });
    const result = reconciliationResult(body, request.operationId);
    if (result.externalId !== request.externalId || result.variantId !== request.variantId || result.epoch !== request.epoch ||
        result.stockUnits !== request.quantity || result.generation !== request.generation + 1) {
      throw new MarketplaceError("invalid_response", "Stock reconciliation returned a different item, quantity, epoch or generation.", 502);
    }
    return result;
  }

  async stockReconciliation(operationId: string): Promise<StockReconcileResult | null> {
    try {
      const body = await this.http.json<StockReconcileWire>("GET", `/stock/reconcile/?operation_id=${encodeURIComponent(operationId)}`);
      return reconciliationResult(body, operationId);
    } catch (error) {
      if (error instanceof MarketplaceError && error.status === 404) return null;
      throw error;
    }
  }

  async pullStock(cursor: number, opts: StockPullOptions): Promise<StockFeed> {
    const forceQs = opts.force ? "&force=1" : "";
    const continuationQs = opts.continuation === undefined ? "" : `&continuation=${encodeURIComponent(opts.continuation)}`;
    const epochQs = `&epoch=${encodeURIComponent(opts.epoch)}`;
    const untilQs = opts.until === undefined ? "" : `&until=${opts.until}`;
    const body = await this.http.json<StockFeedResponse>(
      "GET",
      `/stock/?cursor=${cursor}&limit=500${forceQs}${continuationQs}${epochQs}${untilQs}`,
    );
    if (body.epoch !== opts.epoch || body.watermark === undefined) {
      throw new MarketplaceError("invalid_response", "Stock feed epoch or watermark is missing or changed.", 502);
    }
    stockInteger(body.watermark, "watermark");
    stockInteger(body.next_cursor, "cursor");
    if (body.next_cursor < cursor || body.next_cursor > body.watermark || (opts.until !== undefined && body.watermark !== opts.until)) {
      throw new MarketplaceError("invalid_response", "Stock feed escaped its requested interval.", 502);
    }
    let previous = cursor;
    for (const move of body.movements) {
      const sequence = stockInteger(move.sequence!, "sequence");
      stockInteger(move.revision!, "revision");
      if (sequence <= previous || sequence > body.next_cursor) {
        throw new MarketplaceError("invalid_response", "Stock feed movements are not an ordered committed prefix.", 502);
      }
      previous = sequence;
    }
    return {
      moves: body.movements.map((m) => ({
        id: m.id,
        externalId: m.external_id,
        deltaUnits: m.delta,
        reason: m.reason,
        createdAt: m.created_at,
        epoch: body.epoch!,
        sequence: m.sequence!,
        revision: m.revision!,
      })),
      nextCursor: body.next_cursor,
      ...(body.has_more === undefined ? {} : { hasMore: body.has_more }),
      ...(body.continuation === undefined ? {} : { continuation: body.continuation }),
      epoch: body.epoch!,
      watermark: body.watermark!,
    };
  }

  async listRemoteItems(): Promise<RemoteItem[]> {
    const out: RemoteItem[] = [];
    for (let page = 1; page <= 100; page++) {
      const body = await this.http.json<ProductPage>("GET", `/products/?page=${page}&page_size=100`);
      for (const p of body.results) {
        if (p.variant_id === null) continue;
        // Item group: each variant is a separate billing item, linked by its own id.
        const linked = (p.variants ?? []).filter((v) => v.external_id !== "");
        if (linked.length > 0) {
          for (const v of linked) {
            out.push({
              externalId: v.external_id,
              productId: p.product_id,
              variantId: v.variant_id,
              stockUnits: v.stock,
              pricePaise: decimalToPaise(v.price) ?? 0,
              isActive: p.is_active && v.is_active,
              name: p.name ?? "",
            });
          }
          continue;
        }
        out.push({
          externalId: p.external_id,
          productId: p.product_id,
          variantId: p.variant_id,
          stockUnits: p.stock ?? 0,
          pricePaise: decimalToPaise(p.price) ?? 0,
          isActive: p.is_active,
          name: p.name ?? "",
          ...(p.description === undefined ? {} : { description: p.description }),
          ...(p.main_image === undefined
            ? {}
            : {
                mainImage:
                  p.main_image === null
                    ? null
                    : { id: p.main_image.id, url: p.main_image.url, uploadedAt: p.main_image.uploaded_at },
              }),
        });
      }
      if (!hasNextPage(body)) return out;
      if (page === 100) throw new Error("Marketplace remote items exceed the 100-page pagination limit.");
    }
    return out;
  }

  async listPlatformProducts(): Promise<PlatformProduct[]> {
    const out: PlatformProduct[] = [];
    for (let page = 1; page <= 20; page++) {
      const body = await this.http.json<ProductPage>(
        "GET",
        `/products/?include=all&page=${page}&page_size=100`,
      );
      for (const p of body.results) {
        // An older server ignores ?include=all and omits external_source; without it
        // we can't tell our own products apart. Say so rather than report "none".
        if (p.external_source === undefined) {
          throw new Error("this MyTownCart server doesn't support listing your other products yet");
        }
        if (p.external_source === "billing") continue;
        out.push({
          productId: p.product_id,
          variantId: p.variant_id,
          name: p.name ?? "",
          categoryName: p.category_name ?? "",
          pricePaise: decimalToPaise(p.price) ?? 0,
          stockUnits: p.stock ?? 0,
          isActive: p.is_active,
          ...(p.description === undefined ? {} : { description: p.description }),
        });
      }
      if (!hasNextPage(body)) return out;
      if (page === 20) throw new Error("Marketplace platform products exceed the 20-page pagination limit.");
    }
    return out;
  }

  async adoptProducts(
    entries: { productId: string; externalId: string }[],
  ): Promise<AdoptResult[]> {
    const out: AdoptResult[] = [];
    for (let i = 0; i < entries.length; i += 100) {
      const body = await this.http.json<AdoptResponse>("POST", "/products/adopt/", {
        items: entries.slice(i, i + 100).map((e) => ({
          product_id: e.productId,
          external_id: e.externalId,
        })),
      });
      for (const r of body.results) {
        out.push({
          externalId: r.external_id,
          productId: r.product_id,
          variantId: r.variant_id,
          status: r.status,
          visible: r.visible,
          error: r.error,
        });
      }
    }
    return out;
  }

  // --- Encrypted cloud backups (M5, D13) -----------------------------------
  // The server only ever sees ciphertext; size + SHA-256 are verified on upload.

  async uploadBackup(ciphertext: Uint8Array, meta: CloudBackupMeta): Promise<CloudBackup> {
    const sha256 = await sha256Hex(ciphertext);
    const created = await this.http.json<{ id: string; upload_url: string; upload_method?: string }>(
      "POST", "/backups/", {
        size_bytes: ciphertext.byteLength,
        sha256,
        app_version: meta.appVersion,
        schema_version: meta.schemaVersion,
        crypto_params: meta.cryptoParams,
      },
    );
    const uploaded = await this.http.binary(created.upload_method ?? "PUT", created.upload_url, ciphertext);
    return toCloudBackup(uploaded.json as CloudBackupWire);
  }

  async listBackups(): Promise<CloudBackup[]> {
    const page = await this.http.json<{ results: CloudBackupWire[] }>("GET", "/backups/");
    return page.results.map(toCloudBackup);
  }

  async downloadBackup(id: string): Promise<Uint8Array> {
    const { bytes } = await this.http.binary("GET", `/backups/${encodeURIComponent(id)}/blob/`);
    return bytes;
  }

  async deleteBackup(id: string): Promise<void> {
    await this.http.json("DELETE", `/backups/${encodeURIComponent(id)}/`);
  }

  /** The shop's backup key setting, or null when none is set up yet (404 `no_key`). */
  async getBackupKey(): Promise<BackupKeySetting | null> {
    try {
      const out = await this.http.json<{ mode: string; key?: string }>("GET", "/backups/key/");
      if (out.mode === "managed" && typeof out.key === "string") return { mode: "managed", key: base64ToBytes(out.key) };
      if (out.mode === "private") return { mode: "private" };
      throw new MarketplaceError("server_error", "Unexpected backup key response.", 200);
    } catch (err) {
      if (err instanceof MarketplaceError && err.code === "no_key") return null;
      throw err;
    }
  }

  /**
   * Store the setting. Without `replace`, a different existing setting fails
   * with MarketplaceError `key_exists` (another device got there first).
   */
  async putBackupKey(setting: BackupKeySetting, opts: { replace?: boolean } = {}): Promise<void> {
    await this.http.json("PUT", "/backups/key/", {
      mode: setting.mode,
      ...(setting.mode === "managed" ? { key: bytesToBase64(setting.key) } : {}),
      replace: opts.replace === true,
    });
  }

}

interface CloudBackupWire {
  id: string;
  size_bytes: number;
  sha256: string;
  app_version: string;
  schema_version: number;
  crypto_params: Record<string, string | number>;
  created_at: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toCloudBackup(w: CloudBackupWire): CloudBackup {
  return {
    id: w.id,
    sizeBytes: w.size_bytes,
    sha256: w.sha256,
    appVersion: w.app_version,
    schemaVersion: w.schema_version,
    cryptoParams: w.crypto_params ?? {},
    createdAt: w.created_at,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
