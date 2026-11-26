// SPDX-License-Identifier: Apache-2.0
/**
 * IndexedDB storage for the hosted web app (D13).
 *
 * v2 upgrades from a single `"repo.state"` blob in `"kv"` to per-table
 * record-level object stores so multiple open tabs can read and write
 * concurrently without overwriting each other's changes.
 */

const DB_NAME = "mytowncart-billing";
const DB_VERSION = 2;
export const KV_STORE = "kv";

/** Map-backed collections in `MemoryRepository`, each stored as its own IDB object store. */
export const MAP_STORES = [
  "categories",
  "items",
  "customers",
  "bills",
  "creditNotes",
  "suppliers",
  "purchases",
  "users",
  "pins",
  "batches",
  "itemBarcodes",
  "dayEndClosures",
  "invoiceCounters",
  "photos",
  "itemImages",
  "imageBytes",
  "held",
  "stockStates",
  "stockIntents",
  "stockRequests",
  "stockResults",
  "deliveries",
  "cursors",
  "appSettings",
] as const;

/** Array-backed collections in `MemoryRepository`, stored keyed by numeric array index. */
export const ARRAY_STORES = [
  "customerPayments",
  "auditLogs",
  "loyaltyTransactions",
  "movements",
  "outbox",
] as const;

export type MapStoreName = (typeof MAP_STORES)[number];
export type ArrayStoreName = (typeof ARRAY_STORES)[number];
export type RecordStoreName = MapStoreName | ArrayStoreName;

export const RECORD_STORES: readonly RecordStoreName[] = [...MAP_STORES, ...ARRAY_STORES];
const ALL_STORES: readonly string[] = [KV_STORE, ...RECORD_STORES];

export interface StorePatch {
  puts: [IDBValidKey, unknown][];
  deletes: IDBValidKey[];
  clear?: boolean;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function waitTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("indexeddb_unavailable"));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ALL_STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error("indexeddb_unavailable"));
      req.onblocked = () => reject(new Error("indexeddb_blocked"));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

async function withKvStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  const tx = db.transaction(KV_STORE, mode, { durability: "strict" } as IDBTransactionOptions);
  const result = request(fn(tx.objectStore(KV_STORE)));
  await waitTx(tx);
  return result;
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  return (await withKvStore("readonly", (s) => s.get(key))) as T | undefined;
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  await withKvStore("readwrite", (s) => s.put(value, key));
}

export async function idbDelete(key: string): Promise<void> {
  await withKvStore("readwrite", (s) => s.delete(key));
}

/** Read all `(key, value)` entries from the requested record stores in one readonly transaction. */
export async function idbReadStores(
  stores: readonly RecordStoreName[],
): Promise<Record<string, [IDBValidKey, unknown][]>> {
  if (stores.length === 0) return {};
  const db = await open();
  const tx = db.transaction([...stores], "readonly");
  const pending = stores.map((name) => {
    const store = tx.objectStore(name);
    return Promise.all([request(store.getAllKeys()), request(store.getAll())]).then(
      ([keys, values]) => [name, keys.map((k, i) => [k, values[i]] as [IDBValidKey, unknown])] as const,
    );
  });
  const [entries] = await Promise.all([Promise.all(pending), waitTx(tx)]);
  return Object.fromEntries(entries);
}

/**
 * Atomically apply record-level patches and optional `kv` writes/deletes in a
 * single strict-durability IndexedDB transaction.
 */
export async function idbCommitPatches(
  patches: Record<string, StorePatch>,
  kvPuts: [string, unknown][] = [],
  kvDeletes: string[] = [],
): Promise<void> {
  const storeNames = new Set<string>([KV_STORE, ...Object.keys(patches)]);
  const db = await open();
  const tx = db.transaction([...storeNames], "readwrite", { durability: "strict" } as IDBTransactionOptions);
  for (const [name, patch] of Object.entries(patches)) {
    const store = tx.objectStore(name);
    if (patch.clear) store.clear();
    for (const key of patch.deletes) store.delete(key);
    for (const [key, value] of patch.puts) store.put(value, key);
  }
  const kv = tx.objectStore(KV_STORE);
  for (const key of kvDeletes) kv.delete(key);
  for (const [key, value] of kvPuts) kv.put(value, key);
  await waitTx(tx);
}

/** Removes everything this app stored in the browser (sign-out). */
export async function idbClearAll(): Promise<void> {
  const db = await open();
  const tx = db.transaction([...ALL_STORES], "readwrite", { durability: "strict" } as IDBTransactionOptions);
  for (const name of ALL_STORES) {
    tx.objectStore(name).clear();
  }
  await waitTx(tx);
}
