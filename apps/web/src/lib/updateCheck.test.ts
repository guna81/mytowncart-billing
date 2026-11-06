// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  fetchLatestRelease,
  isNewer,
  parseVersion,
  STORAGE_KEY_LAST_AT,
  STORAGE_KEY_LATEST,
} from "./updateCheck";

describe("updateCheck - version parsing & comparison", () => {
  it("parses valid semver strings with or without leading 'v'", () => {
    expect(parseVersion("v0.1.0")).toEqual([0, 1, 0]);
    expect(parseVersion("0.1.1")).toEqual([0, 1, 1]);
    expect(parseVersion("v0.10.0")).toEqual([0, 10, 0]);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
  });

  it("ignores prerelease and build metadata suffixes for parsing", () => {
    expect(parseVersion("v1.2.3-alpha.1")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3+20261106")).toEqual([1, 2, 3]);
    expect(parseVersion("v0.2.0-rc1+build.5")).toEqual([0, 2, 0]);
  });

  it("returns null for invalid/garbage versions", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("v")).toBeNull();
    expect(parseVersion("v0.1")).toBeNull();
    expect(parseVersion("v0.1.0.1")).toBeNull();
    expect(parseVersion("garbage")).toBeNull();
    expect(parseVersion("v1.x.3")).toBeNull();
    expect(parseVersion("v-1.0.0")).toBeNull();
  });

  it("compares versions correctly in isNewer", () => {
    // Newer major
    expect(isNewer("v1.0.0", "0.9.9")).toBe(true);
    // Newer minor
    expect(isNewer("v0.10.0", "0.9.0")).toBe(true);
    // Newer patch
    expect(isNewer("v0.1.1", "0.1.0")).toBe(true);
    // Same version -> false
    expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "v0.1.0")).toBe(false);
    // Older version -> false
    expect(isNewer("v0.0.9", "0.1.0")).toBe(false);
    expect(isNewer("v0.1.0", "0.2.0")).toBe(false);
    // Garbage / unparseable -> false
    expect(isNewer("garbage", "0.1.0")).toBe(false);
    expect(isNewer("v0.1.0", "garbage")).toBe(false);
    expect(isNewer("invalid", "invalid")).toBe(false);
  });
});

describe("updateCheck - fetchLatestRelease", () => {
  it("returns { tag, url } on 200 with valid GitHub release url", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.2.0",
        html_url: "https://github.com/guna81/mytowncart-billing/releases/tag/v0.2.0",
      }),
    });

    const res = await fetchLatestRelease(mockFetch as unknown as typeof fetch);
    expect(res).toEqual({
      tag: "v0.2.0",
      url: "https://github.com/guna81/mytowncart-billing/releases/tag/v0.2.0",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/guna81/mytowncart-billing/releases/latest",
      expect.objectContaining({
        headers: { Accept: "application/vnd.github+json" },
      }),
    );
  });

  it("returns null when html_url is not a GitHub release url", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.2.0",
        html_url: "https://malicious-site.com/download",
      }),
    });

    const res = await fetchLatestRelease(mockFetch as unknown as typeof fetch);
    expect(res).toBeNull();
  });

  it("returns null on 404 / 403 / non-200 status without throwing", async () => {
    const mockFetch404 = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    expect(await fetchLatestRelease(mockFetch404 as unknown as typeof fetch)).toBeNull();

    const mockFetch403 = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });
    expect(await fetchLatestRelease(mockFetch403 as unknown as typeof fetch)).toBeNull();
  });

  it("returns null on network reject / timeout without throwing", async () => {
    const mockFetchReject = vi.fn().mockRejectedValue(new Error("Network connection lost"));
    expect(await fetchLatestRelease(mockFetchReject as unknown as typeof fetch)).toBeNull();
  });

  it("returns null on malformed JSON without throwing", async () => {
    const mockFetchBadJson = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("Unexpected end of JSON input");
      },
    });
    expect(await fetchLatestRelease(mockFetchBadJson as unknown as typeof fetch)).toBeNull();
  });
});

describe("updateCheck - checkForUpdate workflow", () => {
  const createMockStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => map.set(k, v),
      map,
    };
  };

  it("detects update when 200 returns newer version", async () => {
    const storage = createMockStorage();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.2.0",
        html_url: "https://github.com/guna81/mytowncart-billing/releases/tag/v0.2.0",
      }),
    });

    const result = await checkForUpdate({
      current: "0.1.0",
      storage,
      fetchImpl: mockFetch as unknown as typeof fetch,
      now: 1000000,
    });

    expect(result.available).toBe(true);
    expect(result.tag).toBe("v0.2.0");
    expect(result.url).toBe("https://github.com/guna81/mytowncart-billing/releases/tag/v0.2.0");
    expect(result.failed).toBe(false);
    expect(result.checkedAt).toBe(1000000);

    expect(storage.getItem(STORAGE_KEY_LAST_AT)).toBe("1000000");
    expect(JSON.parse(storage.getItem(STORAGE_KEY_LATEST)!)).toEqual({
      tag: "v0.2.0",
      url: "https://github.com/guna81/mytowncart-billing/releases/tag/v0.2.0",
    });
  });

  it("detects up-to-date when 200 returns current or older version", async () => {
    const storage = createMockStorage();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.1.0",
        html_url: "https://github.com/guna81/mytowncart-billing/releases/tag/v0.1.0",
      }),
    });

    const result = await checkForUpdate({
      current: "0.1.0",
      storage,
      fetchImpl: mockFetch as unknown as typeof fetch,
      now: 1000000,
    });

    expect(result.available).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.tag).toBe("v0.1.0");
  });

  it("returns failed: true when fetch fails, without throwing", async () => {
    const storage = createMockStorage();
    const mockFetch = vi.fn().mockRejectedValue(new Error("Timeout"));

    const result = await checkForUpdate({
      current: "0.1.0",
      storage,
      fetchImpl: mockFetch as unknown as typeof fetch,
      now: 1000000,
    });

    expect(result.available).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.checkedAt).toBe(1000000);
  });

  it("throttles network calls within 24h and serves cached result", async () => {
    const storage = createMockStorage();
    const t0 = 1_000_000;
    storage.setItem(STORAGE_KEY_LAST_AT, String(t0));
    storage.setItem(
      STORAGE_KEY_LATEST,
      JSON.stringify({
        tag: "v0.3.0",
        url: "https://github.com/guna81/mytowncart-billing/releases/tag/v0.3.0",
      }),
    );

    const mockFetch = vi.fn();
    // 5 hours later: should skip network call
    const t1 = t0 + 5 * 60 * 60 * 1000;

    const result = await checkForUpdate({
      current: "0.1.0",
      storage,
      fetchImpl: mockFetch as unknown as typeof fetch,
      now: t1,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.available).toBe(true);
    expect(result.tag).toBe("v0.3.0");
    expect(result.url).toBe("https://github.com/guna81/mytowncart-billing/releases/tag/v0.3.0");
    expect(result.checkedAt).toBe(t0);
    expect(result.failed).toBe(false);
  });

  it("force bypasses 24h throttle and executes network call", async () => {
    const storage = createMockStorage();
    const t0 = 1_000_000;
    storage.setItem(STORAGE_KEY_LAST_AT, String(t0));
    storage.setItem(
      STORAGE_KEY_LATEST,
      JSON.stringify({
        tag: "v0.2.0",
        url: "https://github.com/guna81/mytowncart-billing/releases/tag/v0.2.0",
      }),
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.4.0",
        html_url: "https://github.com/guna81/mytowncart-billing/releases/tag/v0.4.0",
      }),
    });

    const t1 = t0 + 1000; // only 1 second later
    const result = await checkForUpdate({
      current: "0.1.0",
      force: true,
      storage,
      fetchImpl: mockFetch as unknown as typeof fetch,
      now: t1,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.available).toBe(true);
    expect(result.tag).toBe("v0.4.0");
    expect(result.checkedAt).toBe(t1);
  });

  it("does not crash if storage is broken or throws", async () => {
    const faultyStorage = {
      getItem: () => {
        throw new Error("SecurityError: localStorage is disabled");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.5.0",
        html_url: "https://github.com/guna81/mytowncart-billing/releases/tag/v0.5.0",
      }),
    });

    const result = await checkForUpdate({
      current: "0.1.0",
      storage: faultyStorage,
      fetchImpl: mockFetch as unknown as typeof fetch,
      now: 1000000,
    });

    expect(result.available).toBe(true);
    expect(result.tag).toBe("v0.5.0");
  });
});

describe("appStore - runUpdateCheck integration", () => {
  it("skips check when not in Tauri", async () => {
    const { useAppStore } = await import("../store/appStore");
    const res = await useAppStore.getState().runUpdateCheck();
    expect(res).toBeNull();
    expect(useAppStore.getState().updateInfo).toBeNull();
    expect(useAppStore.getState().updateChecking).toBe(false);
  });
});
