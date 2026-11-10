// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetConnectionCacheForTest,
  clearConnection,
  currentToken,
  loadConnection,
  saveConnection,
} from "./connection";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe("connection caching", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.restoreAllMocks();
    _resetConnectionCacheForTest();
    // Simulate Tauri environment
    globalThis.window = {
      __TAURI_INTERNALS__: {},
    } as unknown as Window & typeof globalThis;
  });

  afterEach(() => {
    globalThis.window = originalWindow;
    _resetConnectionCacheForTest();
  });

  it("queries the OS keychain only once when connection is found, then caches in memory", async () => {
    const fakeToken = {
      token: "secret-token-123",
      sellerName: "Test Shop",
      sellerIsApproved: true,
      scopes: ["read", "write"],
    };
    mockInvoke.mockResolvedValueOnce(JSON.stringify(fakeToken));

    // First load -> calls keychain
    const first = await loadConnection();
    expect(first).toEqual(fakeToken);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("keychain_get", { key: "mytowncart.integration" });
    expect(currentToken()).toBe("secret-token-123");

    // Second load -> cached, does not call keychain again
    const second = await loadConnection();
    expect(second).toEqual(fakeToken);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Forced reload -> queries keychain again
    mockInvoke.mockResolvedValueOnce(JSON.stringify(fakeToken));
    const third = await loadConnection({ force: true });
    expect(third).toEqual(fakeToken);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("caches null result when no credential exists, preventing repeated keychain prompts", async () => {
    mockInvoke.mockResolvedValueOnce(null);

    // First load when not connected
    const first = await loadConnection();
    expect(first).toBeNull();
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Second load -> should return cached null without calling keychain again
    const second = await loadConnection();
    expect(second).toBeNull();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(currentToken()).toBeNull();
  });

  it("updates cache on saveConnection and clearConnection", async () => {
    mockInvoke.mockResolvedValue(undefined);

    const newToken = {
      token: "minted-token-456",
      sellerName: "New Shop",
      sellerIsApproved: true,
      scopes: ["pos"],
    };

    await saveConnection(newToken);
    expect(currentToken()).toBe("minted-token-456");

    // Subsequent loadConnection should return new token without keychain_get
    const loaded = await loadConnection();
    expect(loaded).toEqual(newToken);
    expect(mockInvoke).not.toHaveBeenCalledWith("keychain_get", expect.anything());

    // Clear connection
    await clearConnection();
    expect(currentToken()).toBeNull();
    const afterClear = await loadConnection();
    expect(afterClear).toBeNull();
  });
});
