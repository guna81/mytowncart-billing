// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { MemoryRepository, type MemoryState } from "@mytowncart-billing/storage";
import { isReadOnlyCall, persistRepository } from "./persistedRepository";

function harness() {
  const writes: MemoryState[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const persisted = persistRepository(new MemoryRepository(), async (state) => {
    if (hold) await new Promise<void>((r) => { release = r; });
    writes.push(structuredClone(state));
  });
  return {
    persisted,
    writes,
    holdWrites: () => { hold = true; },
    releaseWrite: () => { hold = false; release?.(); },
  };
}

describe("persisted repository (hosted web app)", () => {
  it("classifies reads and writes", () => {
    expect(isReadOnlyCall("listItems")).toBe(true);
    expect(isReadOnlyCall("getShopProfile")).toBe(true);
    expect(isReadOnlyCall("createBill")).toBe(false);
    expect(isReadOnlyCall("setAppSetting")).toBe(false);
  });

  it("writes state after a change resolves, and not after a read", async () => {
    const { persisted, writes } = harness();
    await persisted.repo.listItems();
    expect(writes).toHaveLength(0);
    await persisted.repo.upsertCategory({ name: "Snacks" });
    expect(writes).toHaveLength(1);
    const restored = new MemoryRepository();
    restored.importState(writes[0]!);
    expect((await restored.listCategories()).map((c) => c.name)).toEqual(["Snacks"]);
  });

  it("a change resolves only after its state is written", async () => {
    const { persisted, writes, holdWrites, releaseWrite } = harness();
    holdWrites();
    let done = false;
    const pending = persisted.repo.upsertCategory({ name: "A" }).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    releaseWrite();
    await pending;
    expect(done).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("coalesces changes made while a write is in flight, losing none", async () => {
    const { persisted, writes, holdWrites, releaseWrite } = harness();
    holdWrites();
    const a = persisted.repo.upsertCategory({ name: "A" });
    await new Promise((r) => setTimeout(r, 0));
    const b = persisted.repo.upsertCategory({ name: "B" });
    const c = persisted.repo.upsertCategory({ name: "C" });
    await new Promise((r) => setTimeout(r, 0));
    releaseWrite();
    await Promise.all([a, b, c]);
    await persisted.flush();
    const last = new MemoryRepository();
    last.importState(writes[writes.length - 1]!);
    expect((await last.listCategories()).map((x) => x.name)).toEqual(["A", "B", "C"]);
    expect(writes.length).toBeLessThanOrEqual(2);
  });

  it("notifies listeners with the method name and reports emptiness", async () => {
    const { persisted } = harness();
    const seen: string[] = [];
    persisted.onMutation((m) => seen.push(m));
    expect(await persisted.isEmpty()).toBe(true);
    await persisted.repo.saveShopProfile({
      name: "Shop", gstEnabled: false, pricesIncludeTax: false, invoicePrefix: "INV-", address: "",
      phone: "", gstin: "", receiptFooter: "", lowStockThresholdMilli: 0,
    } as Parameters<MemoryRepository["saveShopProfile"]>[0]);
    expect(seen).toEqual(["saveShopProfile"]);
    expect(await persisted.isEmpty()).toBe(false);
  });
});
