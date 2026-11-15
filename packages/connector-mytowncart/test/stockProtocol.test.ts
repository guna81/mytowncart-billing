// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { MyTownCartConnector } from "../src/myTownCart";
import type { StockReconcileRequest } from "../src/index";

const item = { external_id: "itm_1", variant_id: "550e8400-e29b-41d4-a716-446655440000", stock: 9, revision: 3, generation: 2 };
const epoch = "feed-epoch";
const request: StockReconcileRequest = {
  operationId: "operation-1", externalId: item.external_id, variantId: item.variant_id,
  epoch, expectedRevision: 3, generation: 2, quantity: 9,
};

function setup(body: unknown, status = 200) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  }));
  return { fetch, connector: new MyTownCartConnector({
    apiBaseUrl: "https://api.test/integrations", webBaseUrl: "https://shop.test",
    appVersion: "0.1.4", getToken: () => "test-token", fetch,
  }) };
}

function sent(fetch: ReturnType<typeof setup>["fetch"]) {
  return JSON.parse(String(fetch.mock.calls[0][1]?.body));
}

describe("committed stock protocol", () => {
  it("recognises an unsupported legacy endpoint without masking authentication failures", async () => {
    expect(await setup({}, 404).connector.stockProtocol()).toBeNull();
    await expect(setup({}, 401).connector.stockProtocol()).rejects.toMatchObject({ status: 401 });
    await expect(setup({ protocol: 1, capabilities: [] }).connector.stockProtocol()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("maps coherent snapshots and preserves UUID variant identity", async () => {
    const { connector, fetch } = setup({ protocol: 2, epoch, watermark: 7, items: [item] });
    expect(await connector.stockSnapshot(["itm_1"])).toEqual({
      protocol: 2, epoch, watermark: 7,
      items: [{ externalId: "itm_1", variantId: item.variant_id, stockUnits: 9, revision: 3, generation: 2 }],
    });
    expect(sent(fetch)).toEqual({ external_ids: ["itm_1"] });
    expect(fetch.mock.calls[0][0]).toMatch(/\/stock\/snapshot\/$/);
  });

  it("rejects partial, duplicate and unsafe-integer snapshots", async () => {
    for (const items of [[], [item, item], [{ ...item, stock: Number.MAX_SAFE_INTEGER + 1 }]]) {
      await expect(setup({ protocol: 2, epoch, watermark: 7, items }).connector.enableStockProtocol(["itm_1"]))
        .rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("sends the immutable conditional operation and validates its identity", async () => {
    const result = { ...item, generation: 3, operation_id: request.operationId, epoch, watermark: 8, status: "applied" };
    const { connector, fetch } = setup(result);
    expect(await connector.reconcileStock(request)).toMatchObject({ operationId: request.operationId, stockUnits: 9, watermark: 8 });
    expect(sent(fetch)).toEqual({
      operation_id: request.operationId, external_id: "itm_1", variant_id: item.variant_id,
      epoch, expected_revision: 3, generation: 2, quantity: 9,
    });
    await expect(setup({ ...result, variant_id: "different" }).connector.reconcileStock(request))
      .rejects.toMatchObject({ code: "invalid_response" });
    await expect(setup({ ...result, operation_id: "different" }).connector.reconcileStock(request))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("recovers the original operation by key, and distinguishes an unknown operation from a conflict", async () => {
    expect(await setup({}, 404).connector.stockReconciliation("unknown")).toBeNull();
    await expect(setup({ status: "conflict", error: "Stock revision changed." }, 409).connector.stockReconciliation(request.operationId))
      .rejects.toMatchObject({ status: 409, message: "Stock revision changed." });
    const { connector, fetch } = setup({ ...item, operation_id: request.operationId, epoch, watermark: 8, status: "applied" });
    expect(await connector.stockReconciliation(request.operationId)).toMatchObject({ operationId: request.operationId });
    expect(fetch.mock.calls[0][0]).toMatch(/operation_id=operation-1$/);
  });

  it("sends persisted generation fields without changing the idempotency key", async () => {
    const { connector, fetch } = setup({ results: [{ external_id: "itm_1", status: "duplicate", stock: 9, clamped: false, error: null }] });
    await connector.pushStock([{ externalId: "itm_1", deltaUnits: -1, reason: "sale", idempotencyKey: "stable-key", createdAt: "2026-11-14T00:00:00Z", epoch, variantId: item.variant_id, generation: 2 }]);
    expect(sent(fetch)).toEqual({ movements: [{ external_id: "itm_1", delta: -1, reason: "pos_sale", idempotency_key: "stable-key", epoch, variant_id: item.variant_id, generation: 2 }] });
  });

  it("retains feed sequence/revision and the fixed watermark", async () => {
    const { connector, fetch } = setup({ epoch, watermark: 8, next_cursor: 8, has_more: false, movements: [
      { id: 30, sequence: 7, revision: 3, external_id: "itm_1", delta: -1, reason: "online_order", created_at: "2026-11-14T00:00:00Z" },
    ] });
    const feed = await connector.pullStock(5, { protocol: 2, epoch, until: 8 });
    expect(feed).toMatchObject({ epoch, watermark: 8, nextCursor: 8, moves: [{ sequence: 7, revision: 3, epoch }] });
    expect(fetch.mock.calls[0][0]).toContain("&protocol=2&epoch=feed-epoch&until=8");
  });

  it("rejects a changed epoch, unbounded interval, and unordered feed sequences", async () => {
    const base = { epoch, watermark: 8, next_cursor: 8, movements: [] };
    for (const response of [
      { ...base, epoch: "other" }, { ...base, watermark: 9 }, { ...base, next_cursor: 9 },
      { ...base, movements: [{ id: 1, sequence: 5, revision: 1 }] },
    ]) {
      await expect(setup(response).connector.pullStock(5, { protocol: 2, epoch, until: 8 }))
        .rejects.toMatchObject({ code: "invalid_response" });
    }
  });
});
