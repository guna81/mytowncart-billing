// SPDX-License-Identifier: Apache-2.0
/**
 * Thin fetch layer shared by the MyTownCart connector. Every request carries
 * `X-App-Version` (the server gates on it) and surfaces protocol errors as a
 * typed `MarketplaceError` so the UI can branch on `code` (e.g.
 * `unauthorized` → re-connect, `update_required` → update screen).
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class MarketplaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MarketplaceError";
  }
}

export interface HttpOptions {
  baseUrl: string;
  appVersion: string;
  fetch: FetchLike;
  /** Bearer token for authenticated calls; may be a getter (token can change). */
  token?: () => string | null;
}

interface ErrorBody {
  message?: unknown;
  detail?: unknown;
  code?: unknown;
}

function errorCode(status: number, body: ErrorBody): string {
  if (typeof body.code === "string" && body.code !== "") return body.code;
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "request_failed";
}

function errorMessage(status: number, body: ErrorBody): string {
  if (typeof body.message === "string" && body.message !== "") return body.message;
  if (typeof body.detail === "string" && body.detail !== "") return body.detail;
  return `Request failed (HTTP ${status}).`;
}

export class Http {
  constructor(private readonly opts: HttpOptions) {}

  url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-App-Version": this.opts.appVersion,
      ...extra,
    };
    const token = this.opts.token?.() ?? null;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.opts.fetch(this.url(path), {
        method,
        headers: this.headers(body === undefined ? undefined : { "Content-Type": "application/json" }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new MarketplaceError(
        "network_error",
        err instanceof Error ? err.message : "Network request failed.",
        0,
      );
    }
    const payload = (await readJson(response)) as ErrorBody;
    if (!response.ok) {
      throw new MarketplaceError(
        errorCode(response.status, payload),
        errorMessage(response.status, payload),
        response.status,
      );
    }
    return payload as T;
  }

  /**
   * Download a public media file (a product photo). Sent WITHOUT the bearer
   * token: the media host is not the API and must never see the secret.
   */
  async download(url: string, maxBytes: number): Promise<Uint8Array> {
    const parsed = new URL(url);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
      throw new MarketplaceError("validation_error", "Photo address is not secure.", 0);
    }
    let response: Response;
    try {
      response = await this.opts.fetch(url, { method: "GET" });
    } catch (err) {
      throw new MarketplaceError(
        "network_error",
        err instanceof Error ? err.message : "Network request failed.",
        0,
      );
    }
    if (!response.ok) {
      throw new MarketplaceError("server_error", `Photo download failed (${response.status}).`, response.status);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new MarketplaceError("file_too_large", "Photo is too large.", 0);
    }
    return bytes;
  }

  async upload<T = void>(path: string, file: Blob, filename: string, extra?: Record<string, string>): Promise<T> {
    const form = new FormData();
    form.append("image", file, filename);
    for (const [k, v] of Object.entries(extra ?? {})) form.append(k, v);
    let response: Response;
    try {
      response = await this.opts.fetch(this.url(path), {
        method: "POST",
        headers: this.headers(),
        body: form,
      });
    } catch (err) {
      throw new MarketplaceError(
        "network_error",
        err instanceof Error ? err.message : "Network request failed.",
        0,
      );
    }
    if (!response.ok) {
      const payload = (await readJson(response)) as ErrorBody;
      throw new MarketplaceError(
        errorCode(response.status, payload),
        errorMessage(response.status, payload),
        response.status,
      );
    }
    const payload = await readJson(response);
    return payload as T;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 200) };
  }
}
