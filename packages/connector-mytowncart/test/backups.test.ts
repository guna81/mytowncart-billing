// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { MarketplaceError } from "../src/http";
import { MyTownCartConnector } from "../src/myTownCart";

const API = "https://api.test/api/v1/integrations";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

const wire = {
  id: "b1", size_bytes: 3, sha256: "x", app_version: "0.2.0", schema_version: 1,
  crypto_params: { format: "web-state-v1" }, created_at: "2026-11-26T10:00:00Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function make(routes: [string, RegExp, () => Response][]) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes.find(([method, re]) => (init?.method ?? "GET") === method && re.test(url));
    if (!route) throw new Error(`unexpected ${init?.method} ${url}`);
    return route[2]();
  });
  const connector = new MyTownCartConnector({
    apiBaseUrl: API, webBaseUrl: "https://shop.test", appVersion: "0.2.0",
    getToken: () => "mtc_secret", fetch: fetchFn,
  });
  return { connector, calls };
}

describe("cloud backups", () => {
  it("reserves, uploads ciphertext with size + sha256, and returns the stored backup", async () => {
    const { connector, calls } = make([
      ["POST", /\/backups\/$/, () => json({ id: "b1", upload_url: `${API}/backups/b1/blob/`, upload_method: "PUT" }, 201)],
      ["PUT", /\/backups\/b1\/blob\/$/, () => json(wire)],
    ]);
    const out = await connector.uploadBackup(new Uint8Array([1, 2, 3]), {
      appVersion: "0.2.0", schemaVersion: 1, cryptoParams: { format: "web-state-v1" },
    });
    expect(out.id).toBe("b1");
    expect(out.cryptoParams.format).toBe("web-state-v1");
    const reserve = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(reserve.size_bytes).toBe(3);
    // sha256 of 01 02 03
    expect(reserve.sha256).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
    const put = calls[1]!;
    expect((put.init?.headers as Record<string, string>).Authorization).toBe("Bearer mtc_secret");
    expect((put.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");
    expect(put.init?.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("never sends the token to an upload URL on another host", async () => {
    const { connector, calls } = make([
      ["POST", /\/backups\/$/, () => json({ id: "b1", upload_url: "https://evil.test/steal" }, 201)],
    ]);
    await expect(
      connector.uploadBackup(new Uint8Array([1]), { appVersion: "x", schemaVersion: 1, cryptoParams: {} }),
    ).rejects.toBeInstanceOf(MarketplaceError);
    expect(calls).toHaveLength(1);
  });

  it("lists, downloads and deletes", async () => {
    const { connector } = make([
      ["GET", /\/backups\/$/, () => json({ results: [wire] })],
      ["GET", /\/backups\/b1\/blob\/$/, () => new Response(new Uint8Array([9, 8, 7]), {
        headers: { "Content-Type": "application/octet-stream" },
      })],
      ["DELETE", /\/backups\/b1\/$/, () => new Response(null, { status: 204 })],
    ]);
    const list = await connector.listBackups();
    expect(list.map((b) => [b.id, b.sizeBytes, b.createdAt])).toEqual([["b1", 3, "2026-11-26T10:00:00Z"]]);
    expect(await connector.downloadBackup("b1")).toEqual(new Uint8Array([9, 8, 7]));
    await connector.deleteBackup("b1");
  });

  it("maps a full quota to a typed error", async () => {
    const { connector } = make([
      ["POST", /\/backups\/$/, () => json({ message: "full", code: "quota_exceeded" }, 409)],
    ]);
    await expect(
      connector.uploadBackup(new Uint8Array([1]), { appVersion: "x", schemaVersion: 1, cryptoParams: {} }),
    ).rejects.toMatchObject({ code: "quota_exceeded", status: 409 });
  });
});
