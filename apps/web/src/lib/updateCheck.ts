// SPDX-License-Identifier: Apache-2.0

export const REPO_SLUG = "guna81/mytowncart-billing";
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
export const RELEASES_URL_PREFIX = `https://github.com/${REPO_SLUG}/releases/`;
export const DOWNLOAD_PAGE_URL = "https://guna81.github.io/mytowncart-billing/#download";

export const STORAGE_KEY_LAST_AT = "mtc.updateCheck.lastAt";
export const STORAGE_KEY_LATEST = "mtc.updateCheck.latest";
export const THROTTLE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const REQUEST_TIMEOUT_MS = 8000; // 8 seconds

export type SemverTuple = [number, number, number];

/**
 * Parses MAJOR.MINOR.PATCH from a version string (strips leading 'v', ignores
 * prerelease/build metadata). Returns [major, minor, patch] or null if unparseable.
 */
export function parseVersion(s: string): SemverTuple | null {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim().replace(/^v/i, "");
  // Ignore prerelease (-...) and build metadata (+...)
  const core = trimmed.split(/[-+]/)[0];
  if (!core) return null;

  const parts = core.split(".");
  if (parts.length !== 3) return null;

  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
  }

  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch) ||
    major < 0 ||
    minor < 0 ||
    patch < 0
  ) {
    return null;
  }

  return [major, minor, patch];
}

/**
 * Returns true if latestTag is strictly newer than current version.
 * Returns false if either is unparseable or latest <= current.
 */
export function isNewer(latestTag: string, current: string): boolean {
  const latest = parseVersion(latestTag);
  const cur = parseVersion(current);
  if (!latest || !cur) return false;

  if (latest[0] > cur[0]) return true;
  if (latest[0] < cur[0]) return false;

  if (latest[1] > cur[1]) return true;
  if (latest[1] < cur[1]) return false;

  if (latest[2] > cur[2]) return true;
  return false;
}

export interface LatestRelease {
  tag: string;
  url: string;
}

/**
 * Fetches the latest published release from GitHub API with an 8s timeout.
 * Validates the response and html_url prefix.
 * Never throws; returns null on any error.
 */
export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch,
): Promise<LatestRelease | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetchImpl(LATEST_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    if (!data || typeof data !== "object") {
      return null;
    }

    const tag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
    const url = typeof data.html_url === "string" ? data.html_url.trim() : "";

    if (!tag || !url) {
      return null;
    }

    if (!url.startsWith(RELEASES_URL_PREFIX)) {
      return null;
    }

    return { tag, url };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface CheckForUpdateOptions {
  current: string;
  force?: boolean;
  now?: number;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  fetchImpl?: typeof fetch;
}

export interface UpdateCheckResult {
  available: boolean;
  tag?: string;
  url?: string;
  checkedAt: number;
  failed?: boolean;
}

function safeGetItem(
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined,
  key: string,
): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSetItem(
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined,
  key: string,
  value: string,
): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Ignore storage quota / access issues
  }
}

/**
 * Checks for app updates against GitHub releases.
 * Throttles network calls to once per 24h unless force is true.
 * Shows cached release info while throttled.
 * Never throws.
 */
export async function checkForUpdate(
  options: CheckForUpdateOptions,
): Promise<UpdateCheckResult> {
  const { current, force = false } = options;
  const currentTime = options.now ?? Date.now();
  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof window !== "undefined"
        ? window.localStorage
        : null;
  const fetchImpl = options.fetchImpl ?? fetch;

  const lastAtRaw = safeGetItem(storage, STORAGE_KEY_LAST_AT);
  const lastAt = lastAtRaw ? Number(lastAtRaw) : 0;

  // Throttle check
  if (!force && lastAt > 0 && currentTime - lastAt < THROTTLE_MS) {
    const cachedRaw = safeGetItem(storage, STORAGE_KEY_LATEST);
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw) as Partial<LatestRelease>;
        if (typeof cached.tag === "string" && typeof cached.url === "string") {
          const available = isNewer(cached.tag, current);
          return {
            available,
            tag: cached.tag,
            url: cached.url,
            checkedAt: lastAt,
            failed: false,
          };
        }
      } catch {
        // Cached JSON invalid; proceed without cache
      }
    }
    return {
      available: false,
      checkedAt: lastAt,
      failed: false,
    };
  }

  // Network check
  const release = await fetchLatestRelease(fetchImpl);
  if (!release) {
    return {
      available: false,
      checkedAt: currentTime,
      failed: true,
    };
  }

  safeSetItem(storage, STORAGE_KEY_LAST_AT, String(currentTime));
  safeSetItem(storage, STORAGE_KEY_LATEST, JSON.stringify(release));

  const available = isNewer(release.tag, current);
  return {
    available,
    tag: release.tag,
    url: release.url,
    checkedAt: currentTime,
    failed: false,
  };
}
