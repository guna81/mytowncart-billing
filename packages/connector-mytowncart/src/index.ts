// SPDX-License-Identifier: Apache-2.0
/**
 * `@mytowncart-billing/connector-mytowncart` — the MyTownCart
 * `MarketplaceConnector` (roadmap §8.4).
 *
 * B0 ships the interface only; the fetch-based implementation is B2 and
 * needs the marketplace endpoints from work packages M1/M2.
 *
 * The connector is the ONLY place paise/qty_milli integers are converted to
 * the wire format (roadmap §8.2).
 */

export type Scope = "catalog" | "stock" | "orders" | "backups";

export interface ConnectSession {
  /** User-facing code to approve in the browser (device flow, D8). */
  userCode: string;
  /** URL the seller opens to approve this device. */
  verificationUrl: string;
  /** Resolves once the seller approves; rejects on deny/timeout. */
  waitForApproval(): Promise<void>;
}

export interface MarketplaceProfile {
  sellerId: string;
  sellerName: string;
  sellerIsApproved: boolean;
  limits: { minPollIntervalSeconds: number; bulkMaxItems: number; imageMaxBytes: number };
  /** Server-enforced minimum app version; show "update required" if higher. */
  minBillingAppVersion: string;
}

export interface MarketplaceCategory {
  id: string;
  name: string;
  parentId: string | null;
}

export interface PublishItem {
  externalId: string;
  name: string;
  /** Customer-facing, tax-inclusive price, integer paise (§8.2). */
  pricePaise: number;
  mrpPaise: number;
  /** Integer units in stock; marketplace stock is integer-only (F1). */
  stockUnits: number;
  barcode: string | null;
  categoryId: string;
  isActive: boolean;
  /** Skipped by the server when unchanged since last publish. */
  contentHash: string;
  description?: string;
  /** Send an empty description (the seller cleared it); otherwise empty is never sent. */
  clearDescription?: boolean;
  brand?: string;
  customAttributes?: Record<string, string>;
  /**
   * Set for an option of an item group (sizes/colours). With the connector's
   * `variantGroups` option on, all items sharing a `group.id` are sent as ONE
   * marketplace product with a variant each; otherwise each is its own product.
   */
  group?: { id: string; name: string; options: Record<string, string> };
}

export interface UpsertResult {
  externalId: string;
  productId: string | null;
  variantId: string | null;
  status: "created" | "updated" | "unchanged" | "error";
  /** Visible to shoppers: item is on AND the store is approved (F6). */
  visible: boolean;
  error: string | null;
}

export interface StockPush {
  /** Local item's external id (`itm_<id>`); the server applies the delta to it. */
  externalId: string;
  deltaUnits: number;
  reason: "sale" | "adjustment" | "order_cancel";
  idempotencyKey: string;
  createdAt: string;
}

export interface StockPushResult {
  idempotencyKey: string;
  /** `duplicate` = this key was already applied (safe retry); `error` = see error. */
  status: "applied" | "duplicate" | "error";
  clamped: boolean;
  /** Remote stock after the move, in units; null when the item is unknown. */
  newStockUnits: number | null;
  error: string | null;
}

export interface StockPull {
  id: number;
  externalId: string;
  deltaUnits: number;
  reason: "online_order" | "order_cancel" | "adjustment";
  createdAt: string;
}

export interface RemoteItem {
  externalId: string;
  productId: string;
  variantId: string;
  stockUnits: number;
  pricePaise: number;
  isActive: boolean;
  /** Product name on MyTownCart; absent from older connectors. */
  name?: string;
  /** Description as rich-text HTML; absent when the server doesn't return it yet. */
  description?: string;
  /** Main photo: an object, null when there is none, undefined on an older server. */
  mainImage?: RemoteMainImage | null;
}

/** A product that lives only on MyTownCart (not managed by this app). Read-only. */
export interface PlatformProduct {
  productId: string;
  variantId: string | null;
  name: string;
  categoryName: string;
  pricePaise: number;
  stockUnits: number;
  isActive: boolean;
  /** Rich-text HTML description, when the server returns it. */
  description?: string;
}

/** The photo customers see first. */
export interface RemoteMainImage {
  id: string;
  url: string;
  /** ISO time the photo was uploaded to MyTownCart. */
  uploadedAt: string;
}

/** Outcome of linking one MyTownCart-only product to a local item ("pull"). */
export interface AdoptResult {
  externalId: string;
  productId: string | null;
  variantId: string | null;
  status: "adopted" | "already_linked" | "error";
  visible: boolean;
  error: string | null;
}

/** Persisted connection state; the secret itself lives in the OS keychain. */
export interface ConnectionToken {
  token: string;
  sellerName: string;
  sellerIsApproved: boolean;
  scopes: string[];
}

export interface RemoteProductImage {
  id: string;
  image: string;
  thumbnail?: string;
  isMain: boolean;
}

/**
 * The marketplace-agnostic connector contract (D6). MyTownCart is the first
 * implementation; every request sends `X-App-Version` (§8.4).
 */
export interface MarketplaceConnector {
  connect(clientName: string, scopes: Scope[]): Promise<ConnectSession>;
  me(): Promise<MarketplaceProfile>;
  listCategories(): Promise<MarketplaceCategory[]>;
  upsertItems(items: PublishItem[]): Promise<UpsertResult[]>;
  uploadImage(
    externalId: string,
    file: Blob,
    isMain?: boolean,
  ): Promise<{ imageId?: string; isMain?: boolean; isActive?: boolean } | void>;
  deleteImage?(externalId: string, imageId?: string): Promise<void>;
  listImages?(externalId: string): Promise<RemoteProductImage[]>;
  /** Fetch a product photo by its public address (no credentials are sent). */
  downloadImage?(url: string): Promise<Uint8Array>;
  pushStock(moves: StockPush[]): Promise<StockPushResult[]>;
  pullStock(
    cursor: number,
    opts?: { force?: boolean },
  ): Promise<{ moves: StockPull[]; nextCursor: number }>;
  listRemoteItems(): Promise<RemoteItem[]>;
  /** The seller's products created on MyTownCart itself, for a read-only list. */
  listPlatformProducts(): Promise<PlatformProduct[]>;
  /** Link MyTownCart-only products to local items so later syncs update them. */
  adoptProducts(entries: { productId: string; externalId: string }[]): Promise<AdoptResult[]>;
}

export { MyTownCartConnector, CLIENT_NAME, CONNECT_SCOPES, DEFAULT_API_BASE_URL, DEFAULT_WEB_BASE_URL, paiseToDecimal, decimalToPaise, scopeNames } from "./myTownCart";
export type { MyTownCartOptions } from "./myTownCart";
export { MarketplaceError } from "./http";
export type { FetchLike } from "./http";
