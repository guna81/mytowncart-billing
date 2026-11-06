// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { HttpRepository } from "../src/http";
import { TauriRepository, type InvokeFn } from "../src/tauri";

describe("TauriRepository with custom invoker", () => {
  it("routes query_rows and commands through the injected invoker", async () => {
    const mockInvoker = vi.fn().mockImplementation(async (cmd: string, _args?: Record<string, unknown>) => {
      if (cmd === "query_rows") {
        return [
          {
            id: 1,
            name: "My Local Shop",
            gst_enabled: 1,
            prices_include_tax: 1,
            invoice_prefix: "INV-",
            address: "Main Road",
            phone: "9876543210",
            gstin: "33AAAAA0000A1Z5",
            receipt_footer: "Thank you",
            low_stock_threshold_milli: 5000,
            updated_at: "2026-11-06T12:00:00Z",
          },
        ];
      }
      if (cmd === "save_shop_profile") {
        return undefined;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const repo = new TauriRepository(mockInvoker as unknown as InvokeFn);
    const profile = await repo.getShopProfile();

    expect(mockInvoker).toHaveBeenCalledWith("query_rows", expect.objectContaining({
      sql: expect.stringContaining("SELECT * FROM shop_profile"),
    }));
    expect(profile).not.toBeNull();
    expect(profile?.name).toBe("My Local Shop");
    expect(profile?.gstEnabled).toBe(true);
    expect(profile?.lowStockThresholdMilli).toBe(5000);
  });
});

describe("HttpRepository", () => {
  it("initializes with kind 'http'", () => {
    const repo = new HttpRepository("http://127.0.0.1:8080");
    expect(repo.kind).toBe("http");
  });
});
