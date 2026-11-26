// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { MemoryRepository } from "../src/memory";
import { decodeMemoryState, encodeMemoryState, isWebStateBackup } from "../src/memoryState";
import { seedDemoData } from "../src/seed";

async function seeded(): Promise<MemoryRepository> {
  const repo = new MemoryRepository();
  await seedDemoData(repo);
  await repo.setItemPhoto(1, new Uint8Array([1, 2, 3, 250]), "hash-1");
  await repo.setAppSetting("k", "v");
  return repo;
}

async function snapshotOf(repo: MemoryRepository) {
  return {
    profile: await repo.getShopProfile(),
    items: await repo.listItems(),
    bills: await repo.listBills(),
    customers: await repo.listCustomers(),
    movements: await repo.listMovements(),
    photo: await repo.readItemPhoto(1),
    setting: await repo.getAppSetting("k"),
  };
}

describe("MemoryRepository state round trip (hosted web app, D13)", () => {
  it("restores identical data through the byte encoding", async () => {
    const source = await seeded();
    const bytes = encodeMemoryState(source.exportState());
    expect(isWebStateBackup(bytes)).toBe(true);

    const target = new MemoryRepository();
    target.importState(decodeMemoryState(bytes));
    expect(await snapshotOf(target)).toEqual(await snapshotOf(source));
  });

  it("restores identical data through structuredClone (the IndexedDB path)", async () => {
    const source = await seeded();
    const target = new MemoryRepository();
    target.importState(structuredClone(source.exportState()));
    expect(await snapshotOf(target)).toEqual(await snapshotOf(source));
  });

  it("keeps id counters so new rows never collide after a restore", async () => {
    const source = await seeded();
    const before = (await source.listItems()).map((i) => i.id);
    const target = new MemoryRepository();
    target.importState(decodeMemoryState(encodeMemoryState(source.exportState())));
    const id = await target.upsertItem({
      name: "New after restore", barcode: "", categoryId: null, unitKind: "count",
      pricePaise: 100, mrpPaise: 100, taxRateBp: 0, openingStockMilli: 0, isActive: true,
    });
    expect(before).not.toContain(id);
  });

  it("ignores unknown keys and keeps defaults for missing ones", () => {
    const target = new MemoryRepository();
    target.importState({ notAField: 1, kind: "evil", nextIds: { item: 7 } });
    expect(target.kind).toBe("memory");
    const state = target.exportState() as { nextIds: Record<string, number> };
    expect(state.nextIds.item).toBe(7);
    expect(state.nextIds.category).toBe(1);
    expect("notAField" in state).toBe(false);
  });

  it("rejects bytes that are not a web state backup", () => {
    expect(() => decodeMemoryState(new TextEncoder().encode("MTBD1xxxx"))).toThrow("not_web_state");
    expect(() => decodeMemoryState(new TextEncoder().encode("MTWS1{not json"))).toThrow("corrupt");
    expect(() => decodeMemoryState(new TextEncoder().encode('MTWS1{"v":2,"state":{}}'))).toThrow("corrupt");
  });
});
