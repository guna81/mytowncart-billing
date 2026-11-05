// SPDX-License-Identifier: Apache-2.0
/**
 * Where the marketplace token lives. Inside the desktop shell it is written to
 * the OS keychain through the Rust `keychain_*` commands; a plain browser
 * (dev / Playwright) keeps it in memory only, so it never touches
 * localStorage or a log (§8.7).
 */
import type { ConnectionToken } from "@mytowncart-billing/connector-mytowncart";
import { isInTauri } from "./repository";

const KEYCHAIN_KEY = "mytowncart.integration";

/** Browser store and the per-request token cache in one place. */
let current: ConnectionToken | null = null;

async function invokeKeychain<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

function parse(json: string | null): ConnectionToken | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<ConnectionToken>;
    if (typeof parsed.token !== "string" || parsed.token === "") return null;
    return {
      token: parsed.token,
      sellerName: typeof parsed.sellerName === "string" ? parsed.sellerName : "",
      sellerIsApproved: parsed.sellerIsApproved === true,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((s) => typeof s === "string") : [],
    };
  } catch {
    return null;
  }
}

export async function loadConnection(): Promise<ConnectionToken | null> {
  if (!isInTauri()) return current;
  const stored = await invokeKeychain<string | null>("keychain_get", { key: KEYCHAIN_KEY });
  current = parse(stored);
  return current;
}

export async function saveConnection(next: ConnectionToken): Promise<void> {
  if (isInTauri()) {
    await invokeKeychain<void>("keychain_set", { key: KEYCHAIN_KEY, value: JSON.stringify(next) });
  }
  current = next;
}

export async function clearConnection(): Promise<void> {
  if (isInTauri()) {
    await invokeKeychain<void>("keychain_delete", { key: KEYCHAIN_KEY });
  }
  current = null;
}

/** Token getter handed to the connector; null when disconnected. */
export function currentToken(): string | null {
  return current?.token ?? null;
}
