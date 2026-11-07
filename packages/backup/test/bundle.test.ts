// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { BUNDLE_MAGIC, readBundleManifest, summarizeBackup } from "../src/bundle";
import { decryptSnapshot, encryptSnapshot, generateRecoveryKey } from "../src/crypto";

function makeBundle(photos: { name: string; len: number }[], dbLen = 10): Uint8Array {
  const manifest = new TextEncoder().encode(
    JSON.stringify({ v: 1, db_len: dbLen, item_count: 42, photos }),
  );
  const body = dbLen + photos.reduce((s, p) => s + p.len, 0);
  const out = new Uint8Array(BUNDLE_MAGIC.length + 4 + manifest.length + body);
  out.set(new TextEncoder().encode(BUNDLE_MAGIC), 0);
  new DataView(out.buffer).setUint32(BUNDLE_MAGIC.length, manifest.length, false);
  out.set(manifest, BUNDLE_MAGIC.length + 4);
  return out;
}

describe("bundle manifest", () => {
  it("summarises a v2 bundle", () => {
    const bundle = makeBundle([
      { name: "1.png", len: 5 },
      { name: "2.jpg", len: 7 },
    ]);
    expect(summarizeBackup(bundle)).toEqual({
      format: 2,
      itemCount: 42,
      photoCount: 2,
      photoBytes: 12,
    });
  });

  it("treats non-bundle plaintext as an older database-only backup", () => {
    expect(summarizeBackup(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0]))).toEqual({
      format: 1,
      itemCount: null,
      photoCount: null,
      photoBytes: null,
    });
  });

  it("rejects a bundle whose lengths do not add up", () => {
    const bundle = makeBundle([{ name: "1.png", len: 5 }]);
    expect(readBundleManifest(bundle.subarray(0, bundle.length - 1))).toBeNull();
    const longer = new Uint8Array(bundle.length + 1);
    longer.set(bundle);
    expect(readBundleManifest(longer)).toBeNull();
    expect(summarizeBackup(longer)).toBeNull();
  });

  it("round-trips through the v2 envelope and the header records the format", async () => {
    const { raw } = generateRecoveryKey();
    const bundle = makeBundle([{ name: "1.png", len: 3 }]);
    const sealed = await encryptSnapshot(bundle, raw, {
      schemaVersion: 5,
      appVersion: "0.1.3",
      createdAt: "2026-11-07T00:00:00.000Z",
      format: 2,
    });
    const opened = await decryptSnapshot(sealed, raw);
    expect(opened.header.v).toBe(2);
    expect(summarizeBackup(opened.plaintext)?.photoCount).toBe(1);
  });
});
