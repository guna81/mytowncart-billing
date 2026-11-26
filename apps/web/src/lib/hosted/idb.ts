// SPDX-License-Identifier: Apache-2.0
/** Minimal promise wrapper over one IndexedDB key-value store (hosted mode). */

const DB_NAME = "mytowncart-billing";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("indexeddb_unavailable"));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexeddb_unavailable"));
      req.onblocked = () => reject(new Error("indexeddb_blocked"));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  const tx = db.transaction(STORE, mode, { durability: "strict" } as IDBTransactionOptions);
  const result = request(fn(tx.objectStore(STORE)));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
  return result;
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  return (await withStore("readonly", (s) => s.get(key))) as T | undefined;
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  await withStore("readwrite", (s) => s.put(value, key));
}

export async function idbDelete(key: string): Promise<void> {
  await withStore("readwrite", (s) => s.delete(key));
}

/** Removes everything this app stored in the browser (sign-out). */
export async function idbClearAll(): Promise<void> {
  await withStore("readwrite", (s) => s.clear());
}
