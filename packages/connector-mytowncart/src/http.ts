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
    /** Delay in seconds from a 429 Retry-After header, when valid. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "MarketplaceError";
  }
}

/** Interpret Retry-After only for rate-limited responses. */
export function retryAfterSeconds(response: Response): number | undefined {
  if (response.status !== 429) return undefined;
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  // Avoid Date.parse accepting non-date numeric strings or other loose formats.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

export interface HttpOptions {
  baseUrl: string;
  appVersion: string;
  fetch: FetchLike;
  /** Bearer token for authenticated calls; may be a getter (token can change). */
  token?: () => string | null;
  /**
   * Called on HTTP 401 for authenticated requests. Return `true` after refreshing
   * the token to retry the request once with the updated token.
   */
  onUnauthorized?: (failedToken: string | null) => Promise<boolean>;
}

interface ErrorBody {
  message?: unknown;
  detail?: unknown;
  error?: unknown;
  error_description?: unknown;
  code?: unknown;
}

function errorCode(status: number, body: ErrorBody): string {
  if (typeof body.code === "string" && body.code !== "") return body.code;
  if (typeof body.error === "string" && body.error !== "") return body.error;
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "request_failed";
}

function errorMessage(status: number, body: ErrorBody): string {
  if (typeof body.message === "string" && body.message !== "") return body.message;
  if (typeof body.detail === "string" && body.detail !== "") return body.detail;
  if (typeof body.error_description === "string" && body.error_description !== "") return body.error_description;
  if (typeof body.error === "string" && body.error !== "") return body.error;
  return `Request failed (HTTP ${status}).`;
}

export class Http {
  constructor(private readonly opts: HttpOptions) {}

  url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers(extra?: Record<string, string>, auth = true): { headers: Record<string, string>; usedToken: string | null } {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-App-Version": this.opts.appVersion,
      ...extra,
    };
    const usedToken = auth ? (this.opts.token?.() ?? null) : null;
    if (usedToken) headers.Authorization = `Bearer ${usedToken}`;
    return { headers, usedToken };
  }

  async json<T>(method: string, path: string, body?: unknown, reqOpts?: { auth?: boolean }): Promise<T> {
    const auth = reqOpts?.auth ?? true;
    const send = async () => {
      const { headers, usedToken } = this.headers(
        body === undefined ? undefined : { "Content-Type": "application/json" },
        auth,
      );
      let response: Response;
      try {
        response = await this.opts.fetch(this.url(path), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        throw new MarketplaceError(
          "network_error",
          err instanceof Error ? err.message : "Network request failed.",
          0,
        );
      }
      return { response, usedToken };
    };

    let { response, usedToken } = await send();
    if (auth && response.status === 401 && this.opts.onUnauthorized) {
      if (await this.opts.onUnauthorized(usedToken)) {
        ({ response } = await send());
      }
    }
    const payload = (await readJson(response)) as ErrorBody;
    if (!response.ok) {
      throw new MarketplaceError(
        errorCode(response.status, payload),
        errorMessage(response.status, payload),
        response.status,
        retryAfterSeconds(response),
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
      throw new MarketplaceError("server_error", `Photo download failed (${response.status}).`, response.status, retryAfterSeconds(response));
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new MarketplaceError("file_too_large", "Photo is too large.", 0);
    }
    return bytes;
  }

  /**
   * Binary request/response on this API's own origin (encrypted backups).
   * `target` is a path under the base URL, or an absolute URL the server
   * returned; an absolute URL on any other origin is refused so the bearer
   * token is never sent anywhere but the API.
   */
  async binary(
    method: string,
    target: string,
    body?: Uint8Array,
    extraHeaders?: Record<string, string>,
  ): Promise<{ bytes: Uint8Array; json: unknown }> {
    const url = this.sameOriginUrl(target);
    const send = async () => {
      const { headers, usedToken } = this.headers(
        body === undefined ? extraHeaders : { "Content-Type": "application/octet-stream", ...extraHeaders },
      );
      let response: Response;
      try {
        response = await this.opts.fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : (body as BodyInit),
        });
      } catch (err) {
        throw new MarketplaceError(
          "network_error",
          err instanceof Error ? err.message : "Network request failed.",
          0,
        );
      }
      return { response, usedToken };
    };
    let { response, usedToken } = await send();
    if (response.status === 401 && this.opts.onUnauthorized) {
      if (await this.opts.onUnauthorized(usedToken)) {
        ({ response } = await send());
      }
    }
    if (!response.ok) {
      const payload = (await readJson(response)) as ErrorBody;
      throw new MarketplaceError(
        errorCode(response.status, payload),
        errorMessage(response.status, payload),
        response.status,
        retryAfterSeconds(response),
      );
    }
    const type = response.headers.get("Content-Type") ?? "";
    if (type.includes("application/json")) {
      return { bytes: new Uint8Array(), json: await readJson(response) };
    }
    return { bytes: new Uint8Array(await response.arrayBuffer()), json: null };
  }

  private sameOriginUrl(target: string): string {
    if (!/^https?:\/\//i.test(target)) return this.url(target);
    const base = new URL(this.opts.baseUrl);
    const parsed = new URL(target);
    if (parsed.origin !== base.origin) {
      throw new MarketplaceError("validation_error", "Refusing to send credentials to another host.", 0);
    }
    return parsed.toString();
  }

  async upload<T = void>(path: string, file: Blob, filename: string, extra?: Record<string, string>): Promise<T> {
    const buildForm = () => {
      const form = new FormData();
      form.append("image", file, filename);
      for (const [k, v] of Object.entries(extra ?? {})) form.append(k, v);
      return form;
    };
    const send = async () => {
      const { headers, usedToken } = this.headers();
      let response: Response;
      try {
        response = await this.opts.fetch(this.url(path), {
          method: "POST",
          headers,
          body: buildForm(),
        });
      } catch (err) {
        throw new MarketplaceError(
          "network_error",
          err instanceof Error ? err.message : "Network request failed.",
          0,
        );
      }
      return { response, usedToken };
    };
    let { response, usedToken } = await send();
    if (response.status === 401 && this.opts.onUnauthorized) {
      if (await this.opts.onUnauthorized(usedToken)) {
        ({ response } = await send());
      }
    }
    if (!response.ok) {
      const payload = (await readJson(response)) as ErrorBody;
      throw new MarketplaceError(
        errorCode(response.status, payload),
        errorMessage(response.status, payload),
        response.status,
        retryAfterSeconds(response),
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
