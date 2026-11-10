// The host keeps the marketplace credential; the LAN browser sends requests to it.
import { getSessionToken, resolveAccessKey } from "@mytowncart-billing/storage";

function headers(extra?: HeadersInit): Headers {
  const result = new Headers(extra);
  result.set("X-MTC-Key", resolveAccessKey());
  result.set("X-MTC-Session", getSessionToken() ?? "");
  return result;
}

export async function lanConnection(method: "GET" | "DELETE"): Promise<string | null> {
  const response = await fetch("/api/marketplace/connection", { method, headers: headers() });
  if (!response.ok) throw new Error(await response.text() || `Server error (${response.status})`);
  return await response.json() as string | null;
}

export async function lanMarketplaceFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  const prefix = "/api/v1/integrations";
  if (url.pathname === "/api/v1/products/categories/") return fetch(input, init);
  if (!url.pathname.startsWith(`${prefix}/`)) throw new Error("Invalid marketplace request");
  const forwarded = new Headers(init?.headers);
  forwarded.delete("Authorization");
  return fetch(`/api/marketplace/proxy${url.pathname.slice(prefix.length)}${url.search}`, {
    ...init,
    headers: headers(forwarded),
  });
}
