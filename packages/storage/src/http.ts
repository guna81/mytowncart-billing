// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP repository adapter for MyTownCart Billing.
 * Used when running in a web browser connected to the desktop app's embedded LAN web server.
 * Proxies all repository calls to POST /api/invoke on the server.
 */

import { TauriRepository, type InvokeFn } from "./tauri";

function getDefaultBaseUrl(): string {
  const g = globalThis as { location?: { origin?: string } };
  if (g.location?.origin) {
    return g.location.origin;
  }
  return "http://localhost:8080";
}

export function createHttpInvoker(baseUrl?: string): InvokeFn {
  const resolvedBase = baseUrl || getDefaultBaseUrl();
  return async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const res = await fetch(`${resolvedBase}/api/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
