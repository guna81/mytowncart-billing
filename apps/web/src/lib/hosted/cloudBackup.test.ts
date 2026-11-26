// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { generateRecoveryKey } from "@mytowncart-billing/backup";
import { MemoryRepository, seedDemoData } from "@mytowncart-billing/storage";
import { openSealed, sealState } from "./cloudBackup";

describe("hosted cloud backup sealing", () => {
  it("round-trips a shop through encrypt + gzip with the recovery key", async () => {
    const source = new MemoryRepository();
    await seedDemoData(source);
    const key = generateRecoveryKey();
    const sealed = await sealState(source.exportState(), key.raw, new Date("2026-11-26T10:00:00Z"));

    // Ciphertext must not contain readable shop data.
    const profile = await source.getShopProfile();
    expect(new TextDecoder().decode(sealed)).not.toContain(profile!.name);

    const opened = await openSealed(sealed, key.text);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.createdAt).toBe("2026-11-26T10:00:00.000Z");
    const restored = new MemoryRepository();
    restored.importState(opened.state);
    expect(await restored.listBills()).toEqual(await source.listBills());
    expect(await restored.getShopProfile()).toEqual(profile);
  });

  it("reports a wrong key, a malformed key and a damaged file", async () => {
    const source = new MemoryRepository();
    const key = generateRecoveryKey();
    const sealed = await sealState(source.exportState(), key.raw, new Date());
    expect(await openSealed(sealed, generateRecoveryKey().text)).toEqual({ ok: false, error: "wrong_key" });
    expect(await openSealed(sealed, "not a key")).toEqual({ ok: false, error: "bad_key" });
    expect(await openSealed(new Uint8Array([1, 2, 3]), key.text)).toEqual({ ok: false, error: "corrupt" });
  });
});
