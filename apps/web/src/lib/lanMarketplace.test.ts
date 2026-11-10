import { afterEach, describe, expect, it, vi } from "vitest";
import { lanConnection, lanMarketplaceFetch } from "./lanMarketplace";

vi.mock("@mytowncart-billing/storage", () => ({
  getSessionToken: () => "session",
  resolveAccessKey: () => "lan-key",
}));

afterEach(() => vi.unstubAllGlobals());

describe("LAN marketplace requests", () => {
  it("sends integration requests to the host without the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await lanMarketplaceFetch("https://api.mytowncart.com/api/v1/integrations/me/?page=1", {
      headers: { Authorization: "Bearer secret", "X-App-Version": "1" },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/marketplace/proxy/me/?page=1");
    expect(init.headers.get("Authorization")).toBeNull();
    expect(init.headers.get("X-MTC-Key")).toBe("lan-key");
    expect(init.headers.get("X-MTC-Session")).toBe("session");
  });

  it("loads the host-managed connection and reports host errors", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify('{"token":"host-managed"}')))
      .mockResolvedValueOnce(new Response("credential store unavailable", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await lanConnection("GET")).toBe('{"token":"host-managed"}');
    await expect(lanConnection("DELETE")).rejects.toThrow("credential store unavailable");
  });
});
