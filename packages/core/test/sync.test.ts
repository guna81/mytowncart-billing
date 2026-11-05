// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { checkImage, imageHash, sniffImage } from "../src/media";
import { externalIdOf, type PublishItemInput } from "../src/publish";
import {
  backoffMs,
  chunkMoves,
  dueMovements,
  needsCatalogPush,
  nextAttemptAt,
  reconcile,
  remoteHashOf,
  type ReconcileInput,
} from "../src/sync";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe("photos", () => {
  it("sniffs by magic bytes", () => {
    expect(sniffImage(png)).toBe("png");
    expect(sniffImage(jpeg)).toBe("jpeg");
    expect(sniffImage(webp)).toBe("webp");
    expect(sniffImage(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x2f, 0x3e]))).toBeNull();
  });

  it("rejects empty, oversized and non-image files", () => {
    expect(checkImage({ size: 0 }, png).error).toBe("empty");
    expect(checkImage({ size: 6 * 1024 * 1024 }, png).error).toBe("too_large");
    expect(checkImage({ size: 10 }, new Uint8Array(12)).error).toBe("not_an_image");
    expect(checkImage({ size: png.length }, png)).toEqual({ ok: true, kind: "png", error: null });
  });

  it("hashes the bytes with SHA-256", async () => {
    const hash = await imageHash(png);
    // sha256 of the 12 PNG header bytes.
    expect(hash).toHaveLength(64);
    expect(await imageHash(png)).toBe(hash);
    expect(await imageHash(jpeg)).not.toBe(hash);
  });
});

const baseInput = (over: Partial<PublishItemInput> = {}): PublishItemInput => ({
  id: 7,
  name: "Parle-G",
  barcode: "",
  categoryId: 1,
  unitKind: "count",
  pricePaise: 1000,
  mrpPaise: 1200,
  stockMilli: 5000,
  isActive: true,
  photoPath: "",
  marketplaceCategoryId: "cat-1",
  lastPublishedHash: null,
  ...over,
});

describe("sync planning", () => {
  it("backs off exponentially up to 30 minutes", () => {
    expect(backoffMs(0)).toBe(30_000);
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(50)).toBe(30 * 60_000);
  });

  it("only sends movements whose retry time has arrived", () => {
    const now = new Date("2026-11-05T10:00:00.000Z");
    const due = dueMovements(
      [
        { id: 1, idempotencyKey: "a", externalId: "x", deltaUnits: -1, reason: "sale", attempts: 0, nextAttemptAt: null },
        { id: 2, idempotencyKey: "b", externalId: "x", deltaUnits: -1, reason: "sale", attempts: 1, nextAttemptAt: nextAttemptAt(1, new Date(now.getTime() - 60_000)) },
        { id: 3, idempotencyKey: "c", externalId: "x", deltaUnits: -1, reason: "sale", attempts: 1, nextAttemptAt: nextAttemptAt(1, now) },
      ],
      now,
    );
    expect(due.map((m) => m.id)).toEqual([1, 2]);
  });

  it("chunks a push into server-sized batches", () => {
    expect(chunkMoves([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkMoves([], 100)).toEqual([]);
  });

  it("needs a catalog push only after the first publish", () => {
    const input = baseInput();
    expect(needsCatalogPush(input)).toBe(false);
    const hash = remoteHashOf(input);
    expect(hash).not.toBeNull();
    expect(needsCatalogPush({ ...input, lastPublishedHash: hash })).toBe(false);
    expect(needsCatalogPush({ ...input, lastPublishedHash: hash, pricePaise: 1100 })).toBe(true);
    expect(remoteHashOf({ ...input, marketplaceCategoryId: null })).toBeNull();
  });

  describe("reconcile", () => {
    const localItem = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
      itemId: 7,
      name: "Parle-G",
      stockMilli: 5000,
      pricePaise: 1000,
      remoteProductId: "p1",
      isActive: true,
      ...over,
    });

    it("reports price, stock and inactive differences", () => {
      const rows = reconcile(
        [localItem(), localItem({ itemId: 8, isActive: false })],
        new Map([
          [externalIdOf(7), { externalId: externalIdOf(7), stockUnits: 4, pricePaise: 900, isActive: true }],
          [externalIdOf(8), { externalId: externalIdOf(8), stockUnits: 0, pricePaise: 1000, isActive: true }],
        ]),
      );
      expect(rows.map((r) => [r.itemId, r.kind])).toEqual([
        [7, "stock"],
        [7, "price"],
        [8, "remote_inactive"],
        [8, "stock"],
      ]);
    });

    it("flags an item the marketplace lost, and skips unpublished items", () => {
      const rows = reconcile(
        [localItem(), localItem({ itemId: 9, remoteProductId: null })],
        new Map(),
      );
      expect(rows).toEqual([
        expect.objectContaining({ itemId: 7, kind: "missing_remote", localValue: 5000, remoteValue: null }),
      ]);
    });
  });
});
