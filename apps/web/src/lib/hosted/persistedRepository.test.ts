// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { MemoryRepository, type MemoryState } from "@mytowncart-billing/storage";
import { RECORD_STORES, type RecordStoreName, type StorePatch } from "./idb";
import {
  isReadOnlyCall,
  migrateLegacyBlobIfNeeded,
  persistRecordRepository,
  type RecordStorage,
  type RepoMeta,
} from "./persistedRepository";

interface CommitRecord {
  patches: Record<string, StorePatch>;
  meta: RepoMeta;
  kvDeletes: string[];
}

function fakeSharedStorage(legacyBlob?: MemoryState) {
  const stores = new Map<RecordStoreName, Map<IDBValidKey, unknown>>();
  for (const name of RECORD_STORES) stores.set(name, new Map());
  let meta: RepoMeta | undefined;
  let legacy: MemoryState | undefined = legacyBlob ? structuredClone(legacyBlob) : undefined;
  const commits: CommitRecord[] = [];

  let lockChain: Promise<void> = Promise.resolve();
  let hold = false;
  let release: (() => void) | null = null;

  const storage: RecordStorage = {
    async getMeta() {
      return meta ? structuredClone(meta) : undefined;
    },
    async readStores(names) {
      const out: Record<string, [IDBValidKey, unknown][]> = {};
      for (const name of names) {
        out[name] = [...stores.get(name)!.entries()].map(([k, v]) => [k, structuredClone(v)]);
      }
      return out;
    },
    async commit(patches, nextMeta, kvDeletes = []) {
      if (hold) {
        await new Promise<void>((r) => {
          release = r;
        });
      }
      for (const [name, patch] of Object.entries(patches)) {
        const s = stores.get(name as RecordStoreName)!;
        if (patch.clear) s.clear();
        for (const k of patch.deletes) s.delete(k);
        for (const [k, v] of patch.puts) s.set(k, structuredClone(v));
      }
      meta = structuredClone(nextMeta);
      if (kvDeletes.includes("repo.state")) legacy = undefined;
      commits.push({ patches: structuredClone(patches), meta: structuredClone(nextMeta), kvDeletes: [...kvDeletes] });
    },
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      const next = lockChain.then(fn);
      lockChain = next.then(
        () => {},
        () => {},
      );
      return next;
    },
    async readLegacyBlob() {
      return legacy ? structuredClone(legacy) : undefined;
    },
  };

  return {
    storage,
    commits,
    hasLegacy: () => legacy !== undefined,
    holdWrites: () => {
      hold = true;
    },
    releaseWrite: () => {
      hold = false;
      release?.();
    },
  };
}

const SHOP = {
  name: "Shop",
  gstEnabled: false,
  pricesIncludeTax: false,
  invoicePrefix: "INV-",
  address: "",
  phone: "",
  gstin: "",
  receiptFooter: "",
  lowStockThresholdMilli: 0,
};

describe("persisted record-level repository (hosted web app)", () => {
  it("classifies reads and writes", () => {
    expect(isReadOnlyCall("listItems")).toBe(true);
    expect(isReadOnlyCall("getShopProfile")).toBe(true);
    expect(isReadOnlyCall("createBill")).toBe(false);
    expect(isReadOnlyCall("setAppSetting")).toBe(false);
  });

  it("writes only changed records after a mutation, and nothing on reads", async () => {
    const { storage, commits } = fakeSharedStorage();
    const tab = persistRecordRepository(new MemoryRepository(), storage);

    await tab.repo.listItems();
    expect(commits).toHaveLength(0);

    const catId = await tab.repo.upsertCategory({ name: "Snacks" });
    expect(commits).toHaveLength(1);
    expect(Object.keys(commits[0]!.patches)).toEqual(["categories"]);
    expect(commits[0]!.patches.categories!.puts).toHaveLength(1);
    expect(commits[0]!.patches.categories!.puts[0]![0]).toBe(catId);

    const freshTab = persistRecordRepository(new MemoryRepository(), storage);
    expect((await freshTab.repo.listCategories()).map((c) => c.name)).toEqual(["Snacks"]);
  });

  it("a change resolves only after its commit completes", async () => {
    const { storage, commits, holdWrites, releaseWrite } = fakeSharedStorage();
    const tab = persistRecordRepository(new MemoryRepository(), storage);
    holdWrites();
    let done = false;
    const pending = tab.repo.upsertCategory({ name: "A" }).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    releaseWrite();
    await pending;
    expect(done).toBe(true);
    expect(commits).toHaveLength(1);
  });

  it("supports concurrent multi-tab writes without overwriting categories or bills", async () => {
    const { storage } = fakeSharedStorage();
    const tabA = persistRecordRepository(new MemoryRepository(), storage);
    const tabB = persistRecordRepository(new MemoryRepository(), storage);

    await tabA.repo.saveShopProfile(SHOP);
    const itemId = await tabA.repo.upsertItem({
      name: "Tea Pack",
      barcode: "8901234567890",
      categoryId: null,
      unitKind: "count",
      pricePaise: 5000,
      mrpPaise: 5500,
      taxRateBp: 0,
      openingStockMilli: 10_000,
      isActive: true,
    });

    // Both tabs write concurrently: different categories and concurrent bills.
    const [catA, catB, billA, billB] = await Promise.all([
      tabA.repo.upsertCategory({ name: "Beverages" }),
      tabB.repo.upsertCategory({ name: "Dairy" }),
      tabA.repo.createBill({
        fy: "2026-27",
        prefix: "INV-",
        customerId: null,
        subtotalPaise: 5000,
        taxPaise: 0,
        totalPaise: 5000,
        createdAt: "2026-11-26T10:00:00.000Z",
        lines: [
          {
            itemId,
            nameSnapshot: "Tea Pack",
            qtyMilli: 2000,
            unitPricePaise: 5000,
            taxRateBp: 0,
            taxPaise: 0,
            totalPaise: 5000,
          },
        ],
        payments: [{ mode: "cash", amountPaise: 5000 }],
      }),
      tabB.repo.createBill({
        fy: "2026-27",
        prefix: "INV-",
        customerId: null,
        subtotalPaise: 10000,
        taxPaise: 0,
        totalPaise: 10000,
        createdAt: "2026-11-26T10:00:01.000Z",
        lines: [
          {
            itemId,
            nameSnapshot: "Tea Pack",
            qtyMilli: 3000,
            unitPricePaise: 5000,
            taxRateBp: 0,
            taxPaise: 0,
            totalPaise: 10000,
          },
        ],
        payments: [{ mode: "upi", amountPaise: 10000 }],
      }),
    ]);

    expect(catA).not.toBe(catB);
    expect(billA.number).not.toBe(billB.number);

    // Both tabs see all categories, both bills, and combined stock deduction (10 - 2 - 3 = 5).
    const catsA = (await tabA.repo.listCategories()).map((c) => c.name).sort();
    const catsB = (await tabB.repo.listCategories()).map((c) => c.name).sort();
    expect(catsA).toEqual(["Beverages", "Dairy"]);
    expect(catsB).toEqual(["Beverages", "Dairy"]);

    expect(await tabA.repo.listBills()).toHaveLength(2);
    expect(await tabB.repo.listBills()).toHaveLength(2);

    const itemFromA = await tabA.repo.getItem(itemId);
    const itemFromB = await tabB.repo.getItem(itemId);
    expect(itemFromA?.stockMilli).toBe(5000);
    expect(itemFromB?.stockMilli).toBe(5000);
  });

  it("migrates legacy v1 single-blob state into record stores once", async () => {
    const legacyRepo = new MemoryRepository();
    await legacyRepo.saveShopProfile(SHOP);
    await legacyRepo.upsertCategory({ name: "Legacy Cat" });
    const { storage, hasLegacy } = fakeSharedStorage(legacyRepo.exportState());

    expect(hasLegacy()).toBe(true);
    expect(await migrateLegacyBlobIfNeeded(storage)).toBe(true);
    expect(hasLegacy()).toBe(false);
    expect(await migrateLegacyBlobIfNeeded(storage)).toBe(false);

    const tab = persistRecordRepository(new MemoryRepository(), storage);
    expect((await tab.repo.getShopProfile())?.name).toBe("Shop");
    expect((await tab.repo.listCategories()).map((c) => c.name)).toEqual(["Legacy Cat"]);
  });

  it("notifies listeners with the method name and reports emptiness across tabs", async () => {
    const { storage } = fakeSharedStorage();
    const tabA = persistRecordRepository(new MemoryRepository(), storage);
    const tabB = persistRecordRepository(new MemoryRepository(), storage);
    const seen: string[] = [];
    tabA.onMutation((m) => seen.push(m));
    expect(await tabA.isEmpty()).toBe(true);
    expect(await tabB.isEmpty()).toBe(true);

    await tabA.repo.saveShopProfile(SHOP);
    expect(seen).toEqual(["saveShopProfile"]);
    expect(await tabA.isEmpty()).toBe(false);
    expect(await tabB.isEmpty()).toBe(false);
  });
});
