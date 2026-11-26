// SPDX-License-Identifier: Apache-2.0
/**
 * Hosted web OAuth 2.1 Authorization Code + PKCE sign-in and multi-tab-safe
 * refresh-token rotation.
 *
 * Flow:
 *   1. Register a public OAuth client (cached per API origin + redirect URI).
 *   2. Generate PKCE verifier/challenge (S256) + CSRF `state`, store in
 *      `sessionStorage`, and navigate this tab to `/oauth/authorize/`.
 *   3. MyTownCart redirects back to `redirectUri?code=...&state=...` (or
 *      `?error=...`).
 *   4. Exchange the code at `/oauth/token/`, verify required scopes, save the
 *      access + refresh tokens in IndexedDB, and strip query params from the URL.
 *   5. On 401, rotate the refresh token under a short Web Lock so concurrent
 *      tabs never race on the same rotating refresh token.
 */
import { scopeNames, type Scope } from "@mytowncart-billing/connector-mytowncart";

import { clearConnection, loadConnection, saveConnection } from "../connection";
import { getConnector, MARKETPLACE_API_URL } from "../marketplace";
import { idbGet, idbSet } from "./idb";
import { HOSTED_CLIENT_NAME } from "./mode";
import type { PersistedRepository } from "./persistedRepository";
import { dataOwner, setDataOwner } from "./session";
import { broadcastTabEvent } from "./tabSync";

const OAUTH_SCOPES: readonly Scope[] = ["catalog", "stock", "orders", "backups"];
const PENDING_KEY = "mtc.hosted.oauth.pending";
const CLIENT_CACHE_KEY = "oauth.client";
const REFRESH_LOCK_NAME = "mytowncart-billing-token-refresh";
const PENDING_MAX_AGE_MS = 15 * 60_000;

interface PendingOAuth {
  state: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  createdAt: number;
}

interface CachedOAuthClient {
  apiBaseUrl: string;
  redirectUri: string;
  clientId: string;
}

export type OAuthCallbackResult =
  | { ok: true }
  | { ok: false; otherShop: true }
  | { ok: false; otherShop?: false; code: string; message: string };

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateRandomUrlSafe(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function computeS256Challenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

/** Clean redirect URI for the current hosted app (no query string or hash). */
export function oauthRedirectUri(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

async function getOrRegisterClientId(redirectUri: string): Promise<string> {
  const cached = await idbGet<CachedOAuthClient>(CLIENT_CACHE_KEY);
  if (
    cached &&
    cached.apiBaseUrl === MARKETPLACE_API_URL &&
    cached.redirectUri === redirectUri &&
    typeof cached.clientId === "string" &&
    cached.clientId !== ""
  ) {
    return cached.clientId;
  }
  const { clientId } = await getConnector().registerOAuthClient(HOSTED_CLIENT_NAME, redirectUri);
  await idbSet(CLIENT_CACHE_KEY, {
    apiBaseUrl: MARKETPLACE_API_URL,
    redirectUri,
    clientId,
  } satisfies CachedOAuthClient);
  return clientId;
}

/**
 * Start the OAuth Authorization Code + PKCE sign-in by redirecting the current
 * tab to MyTownCart's `/oauth/authorize/` endpoint.
 */
export async function startHostedOAuthSignIn(): Promise<void> {
  const redirectUri = oauthRedirectUri();
  const clientId = await getOrRegisterClientId(redirectUri);
  const state = generateRandomUrlSafe(24);
  const codeVerifier = generateRandomUrlSafe(32);
  const codeChallenge = await computeS256Challenge(codeVerifier);

  const pending: PendingOAuth = {
    state,
    codeVerifier,
    clientId,
    redirectUri,
    createdAt: Date.now(),
  };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));

  const authorizeUrl = getConnector().buildOAuthAuthorizeUrl({
    clientId,
    redirectUri,
    scopes: OAUTH_SCOPES,
    state,
    codeChallenge,
  });
  window.location.assign(authorizeUrl);
}

/** True when the current URL query string carries an OAuth callback response. */
export function hasOAuthCallback(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.has("code") || params.has("error");
}

function stripOAuthParamsFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  const clean = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, "", clean);
}

function takePendingOAuth(): PendingOAuth | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingOAuth>;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.codeVerifier !== "string" ||
      typeof parsed.clientId !== "string" ||
      typeof parsed.redirectUri !== "string" ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.createdAt > PENDING_MAX_AGE_MS) return null;
    return parsed as PendingOAuth;
  } catch {
    return null;
  }
}

/**
 * Consume the OAuth callback query parameters, exchange the code for tokens,
 * verify scopes and shop ownership, and persist the connection.
 */
export async function finishHostedOAuthCallback(
  persisted: PersistedRepository | null,
): Promise<OAuthCallbackResult> {
  const params = new URLSearchParams(window.location.search);
  const errorParam = params.get("error");
  const errorDesc = params.get("error_description");
  const code = params.get("code");
  const state = params.get("state");

  // Always clean the URL immediately so a reload never replays the code.
  stripOAuthParamsFromUrl();
  const pending = takePendingOAuth();

  if (errorParam) {
    return {
      ok: false,
      code: errorParam,
      message: errorDesc || (errorParam === "access_denied" ? "Connection was denied." : errorParam),
    };
  }
  if (!code || !pending || state !== pending.state) {
    return {
      ok: false,
      code: "invalid_state",
      message: "Sign-in session expired or did not match. Please try again.",
    };
  }

  const connector = getConnector();
  const tokenRes = await connector.exchangeOAuthCode({
    clientId: pending.clientId,
    code,
    redirectUri: pending.redirectUri,
    codeVerifier: pending.codeVerifier,
  });

  if (!scopeNames(["backups"]).every((s) => tokenRes.scopes.includes(s))) {
    return { ok: false, code: "missing_scope", message: "missing_scope" };
  }

  const expiresAt = Date.now() + tokenRes.expiresIn * 1000;
  await saveConnection({
    token: tokenRes.accessToken,
    sellerName: "",
    sellerIsApproved: false,
    scopes: tokenRes.scopes,
    refreshToken: tokenRes.refreshToken,
    expiresAt,
    clientId: pending.clientId,
  });

  const me = await connector.me();
  const owner = await dataOwner();
  const hasData = persisted ? !(await persisted.isEmpty()) : false;
  if (owner && owner !== me.sellerId && hasData) {
    // Never back one shop's bills up into another seller's account.
    await clearConnection();
    return { ok: false, otherShop: true };
  }

  await saveConnection({
    token: tokenRes.accessToken,
    sellerName: me.sellerName,
    sellerIsApproved: me.sellerIsApproved,
    scopes: tokenRes.scopes,
    refreshToken: tokenRes.refreshToken,
    expiresAt,
    clientId: pending.clientId,
  });
  await setDataOwner(me.sellerId);
  broadcastTabEvent({ type: "signed_in" });
  return { ok: true };
}

let inTabRefresh: Promise<boolean> | null = null;

async function runWithRefreshLock(fn: () => Promise<boolean>): Promise<boolean> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) {
    return locks.request(REFRESH_LOCK_NAME, () => fn()) as unknown as Promise<boolean>;
  }
  if (!inTabRefresh) {
    inTabRefresh = fn().finally(() => {
      inTabRefresh = null;
    });
  }
  return inTabRefresh;
}

/**
 * Rotate the OAuth refresh token safely across tabs. Returns `true` if a fresh
 * access token is now stored (either rotated by this tab or by another tab
 * while we waited for the lock), or `false` if re-authentication is required.
 */
export async function refreshHostedToken(failedToken: string | null): Promise<boolean> {
  return runWithRefreshLock(async () => {
    const stored = await loadConnection({ force: true });
    if (!stored) return false;
    // Another tab already rotated the token while we were waiting.
    if (
      failedToken !== null &&
      stored.token !== failedToken &&
      (!stored.expiresAt || stored.expiresAt > Date.now() + 30_000)
    ) {
      return true;
    }
    if (!stored.refreshToken || !stored.clientId) return false;
    try {
      const next = await getConnector().refreshOAuthToken({
        clientId: stored.clientId,
        refreshToken: stored.refreshToken,
      });
      await saveConnection({
        ...stored,
        token: next.accessToken,
        refreshToken: next.refreshToken ?? stored.refreshToken,
        expiresAt: Date.now() + next.expiresIn * 1000,
        scopes: next.scopes.length > 0 ? next.scopes : stored.scopes,
      });
      broadcastTabEvent({ type: "token_refreshed" });
      return true;
    } catch {
      return false;
    }
  });
}
