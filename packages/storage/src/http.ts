// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP repository adapter for MyTownCart Billing.
 * Used when running in a web browser connected to the desktop app's embedded LAN web server.
 * Proxies all repository calls to POST /api/invoke on the server.
 */

import { getSessionToken } from "./session";
import { TauriRepository, type InvokeFn } from "./tauri";

function getDefaultBaseUrl(): string {
  const g = globalThis as { location?: { origin?: string } };
  if (g.location?.origin) {
    return g.location.origin;
  }
  return "http://localhost:8080";
}

const KEY_STORAGE = "mtc.lan.key";

/** The LAN access key arrives as `?key=` in the URL shown by the desktop app; keep it for the tab. */
function resolveAccessKey(): string {
  const g = globalThis as {
    location?: { search?: string; pathname?: string; hash?: string };
    sessionStorage?: Storage;
    history?: { replaceState?: (d: unknown, t: string, u: string) => void };
  };
  try {
    const fromUrl = new URLSearchParams(g.location?.search ?? "").get("key");
    if (fromUrl) {
      g.sessionStorage?.setItem(KEY_STORAGE, fromUrl);
      // Drop the key from the visible URL / history.
      g.history?.replaceState?.(null, "", `${g.location?.pathname ?? "/"}${g.location?.hash ?? ""}`);
      return fromUrl;
    }
    return g.sessionStorage?.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function createHttpInvoker(baseUrl?: string): InvokeFn {
  const resolvedBase = baseUrl || getDefaultBaseUrl();
  const accessKey = resolveAccessKey();
  return async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const res = await fetch(`${resolvedBase}/api/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MTC-Key": accessKey,
        "X-MTC-Session": getSessionToken() ?? "",
      },
      body: JSON.stringify({ cmd, args: args ?? {} }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `Server error (${res.status})`);
    }
    return (await res.json()) as T;
  };
}

export class HttpRepository extends TauriRepository {
  override readonly kind = "http" as const;

  constructor(baseUrl?: string) {
    super(createHttpInvoker(baseUrl));
  }
}
