// SPDX-License-Identifier: Apache-2.0
/**
 * Multi-tab, record-level IndexedDB repository for the hosted web app (D2, D13).
 *
 * Each collection in `MemoryRepository` is stored in its own IndexedDB object
 * store (`idb.ts`), and every mutating call:
 *   1. Acquires a short-lived Web Lock (`mytowncart-billing-tx`).
 *   2. Syncs any records modified by other tabs since this tab's last revision.
 *   3. Runs the domain logic in `MemoryRepository`.
 *   4. Diffs the collections and commits ONLY the changed/deleted records plus
 *      metadata (`shopProfile`, `nextIds`, `rev`) in one atomic strict-durability
 *      IndexedDB transaction.
 *   5. Broadcasts the new revision to other open tabs.
 *
 * Reads automatically pull any newer revision before returning, so multiple
 * tabs stay consistent without ever blocking each other or overwriting bills.
 */
import { MemoryRepository, type BillingRepository, type MemoryState } from "@mytowncart-billing/storage";
import {
  ARRAY_STORES,
  MAP_STORES,
  RECORD_STORES,
  idbCommitPatches,
  idbGet,
  idbReadStores,
  type RecordStoreName,
  type StorePatch,
} from "./idb";
import { broadcastTabEvent } from "./tabSync";

/** Legacy v1 single-blob key (migrated automatically on first open). */
export const STATE_KEY = "repo.state";
export const META_KEY = "repo.meta";

const TX_LOCK_NAME = "mytowncart-billing-tx";
const RECENT_CHANGES_LIMIT = 64;

/** Calls that never change data; everything else is persisted atomically. */
const READ_ONLY = /^(list|get|read|find|lookup|verify|logout)/;

/** Binary stores whose values are never mutated in place (replaced via Map.set/delete). */
const BINARY_STORES = new Set<RecordStoreName>(["photos", "imageBytes"]);
const MAP_STORE_SET = new Set<string>(MAP_STORES);
const ARRAY_STORE_SET = new Set<string>(ARRAY_STORES);
const KNOWN_FIELDS = new Set<string>(["shopProfile", "nextIds", ...RECORD_STORES]);

export type MutationListener = (method: string) => void;

export interface RepoMeta {
  rev: number;
  shopProfile: unknown;
  nextIds: Record<string, number>;
  /** Ring buffer of recent revisions' touched stores for fast incremental sync. */
  recentChanges?: { rev: number; stores: RecordStoreName[] }[];
  /** Any future `MemoryRepository` fields not yet in `RECORD_STORES`. */
  extra?: Record<string, unknown>;
}

export interface RecordStorage {
  getMeta(): Promise<RepoMeta | undefined>;
  readStores(stores: readonly RecordStoreName[]): Promise<Record<string, [IDBValidKey, unknown][]>>;
  commit(patches: Record<string, StorePatch>, meta: RepoMeta, kvDeletes?: string[]): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  readLegacyBlob?(): Promise<MemoryState | undefined>;
}

export interface PersistedRepository {
  repo: BillingRepository;
  memory: MemoryRepository;
  /** Resolves once every in-flight mutation in this tab is committed to IndexedDB. */
  flush(): Promise<void>;
  /** Pull any changes committed by other tabs into `memory`. */
  sync(): Promise<void>;
  onMutation(listener: MutationListener): () => void;
  /** True when this browser holds no shop yet (fresh install or cleared). */
  isEmpty(): Promise<boolean>;
}

export function isReadOnlyCall(method: string): boolean {
  return READ_ONLY.test(method);
}

export function withTxLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (typeof navigator !== "undefined" ? navigator.locks : undefined) as LockManager | undefined;
  if (!locks) return fn();
  return locks.request(TX_LOCK_NAME, () => fn()) as Promise<T>;
}

function fingerprint(store: RecordStoreName, value: unknown): unknown {
  return BINARY_STORES.has(store) ? value : JSON.stringify(value);
}

function extractExtra(state: MemoryState): Record<string, unknown> | undefined {
  let extra: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(state)) {
    if (KNOWN_FIELDS.has(key)) continue;
    extra ??= {};
    extra[key] = value;
  }
  return extra;
}

function metaFingerprint(shopProfile: unknown, nextIds: unknown, extra: unknown): string {
  return JSON.stringify({ shopProfile: shopProfile ?? null, nextIds: nextIds ?? {}, extra: extra ?? null });
}

function buildFullPatches(state: MemoryState, clear: boolean): Record<string, StorePatch> {
  const patches: Record<string, StorePatch> = {};
  for (const name of MAP_STORES) {
    const val = state[name];
    const puts: [IDBValidKey, unknown][] = val instanceof Map ? [...val.entries()] : [];
    if (clear || puts.length > 0) patches[name] = { puts, deletes: [], clear };
  }
  for (const name of ARRAY_STORES) {
    const val = state[name];
    const puts: [IDBValidKey, unknown][] = Array.isArray(val) ? val.map((item, idx) => [idx, item]) : [];
    if (clear || puts.length > 0) patches[name] = { puts, deletes: [], clear };
  }
  return patches;
}

function storesChangedSince(meta: RepoMeta, localRev: number): readonly RecordStoreName[] {
  if (localRev <= 0 || !meta.recentChanges || meta.recentChanges.length === 0) {
    return RECORD_STORES;
  }
  const needed = meta.rev - localRev;
  if (needed <= 0) return [];
  const relevant = meta.recentChanges.filter((c) => c.rev > localRev && c.rev <= meta.rev);
  if (relevant.length !== needed) {
    return RECORD_STORES;
  }
  const set = new Set<RecordStoreName>();
  for (const entry of relevant) {
    for (const s of entry.stores) set.add(s);
  }
  return [...set];
}

export function createIdbRecordStorage(): RecordStorage {
  return {
    getMeta: () => idbGet<RepoMeta>(META_KEY),
    readStores: (stores) => idbReadStores(stores),
    commit: (patches, meta, kvDeletes = []) => idbCommitPatches(patches, [[META_KEY, meta]], kvDeletes),
    withLock: withTxLock,
    readLegacyBlob: () => idbGet<MemoryState>(STATE_KEY),
  };
}

export function persistRecordRepository(
  memory: MemoryRepository,
  storage: RecordStorage,
  options?: { broadcast?: boolean },
): PersistedRepository {
  const broadcast = options?.broadcast ?? false;
  const listeners = new Set<MutationListener>();

  const fingerprints = new Map<RecordStoreName, Map<IDBValidKey, unknown>>();
  for (const name of RECORD_STORES) fingerprints.set(name, new Map());

  const initialState = memory.exportState();
  let committedMetaFp = metaFingerprint(initialState.shopProfile, initialState.nextIds, extractExtra(initialState));
  let localRev = 0;
  let recentChanges: { rev: number; stores: RecordStoreName[] }[] = [];

  let queue: Promise<void> = Promise.resolve();
  let syncing: Promise<void> | null = null;

  const applyMetaAndStores = (meta: RepoMeta, loaded: Record<string, [IDBValidKey, unknown][]>) => {
    const partial: MemoryState = {
      shopProfile: meta.shopProfile ?? null,
      nextIds: meta.nextIds ?? {},
      ...(meta.extra ?? {}),
    };

    for (const [name, entries] of Object.entries(loaded)) {
      const storeName = name as RecordStoreName;
      const storeFp = new Map<IDBValidKey, unknown>();
      if (MAP_STORE_SET.has(storeName)) {
        const map = new Map<unknown, unknown>();
        for (const [k, v] of entries) {
          map.set(k, v);
          storeFp.set(k, fingerprint(storeName, v));
        }
        partial[storeName] = map;
      } else if (ARRAY_STORE_SET.has(storeName)) {
        const arr: unknown[] = [];
        const sorted = [...entries].sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [k, v] of sorted) {
          arr.push(v);
          storeFp.set(Number(k), fingerprint(storeName, v));
        }
        partial[storeName] = arr;
      }
      fingerprints.set(storeName, storeFp);
    }

    memory.importState(partial);
    committedMetaFp = metaFingerprint(meta.shopProfile, meta.nextIds, meta.extra);
    localRev = meta.rev;
    recentChanges = meta.recentChanges ? [...meta.recentChanges] : [];
  };

  const resetEmpty = () => {
    const fresh = new MemoryRepository();
    const emptyState = fresh.exportState();
    memory.importState(emptyState);
    for (const name of RECORD_STORES) fingerprints.set(name, new Map());
    committedMetaFp = metaFingerprint(emptyState.shopProfile, emptyState.nextIds, extractExtra(emptyState));
    localRev = 0;
    recentChanges = [];
  };

  const doSync = async (): Promise<void> => {
    const meta = await storage.getMeta();
    if (!meta) {
      if (localRev !== 0) resetEmpty();
      return;
    }
    if (meta.rev === localRev) return;
    const toLoad = storesChangedSince(meta, localRev);
    const loaded = toLoad.length > 0 ? await storage.readStores(toLoad) : {};
    applyMetaAndStores(meta, loaded);
  };

  const sync = (): Promise<void> => {
    if (!syncing) {
      syncing = doSync().finally(() => {
        syncing = null;
      });
    }
    return syncing;
  };

  const computeDiff = (): {
    patches: Record<string, StorePatch>;
    touchedStores: RecordStoreName[];
    nextFingerprints: Map<RecordStoreName, Map<IDBValidKey, unknown>>;
    metaChanged: boolean;
    nextMetaFp: string;
    state: MemoryState;
    extra: Record<string, unknown> | undefined;
  } => {
    const state = memory.exportState();
    const patches: Record<string, StorePatch> = {};
    const touchedStores: RecordStoreName[] = [];
    const nextFingerprints = new Map<RecordStoreName, Map<IDBValidKey, unknown>>();

    for (const name of MAP_STORES) {
      const prev = fingerprints.get(name)!;
      const curr = state[name] instanceof Map ? (state[name] as Map<IDBValidKey, unknown>) : new Map<IDBValidKey, unknown>();
      const puts: [IDBValidKey, unknown][] = [];
      const deletes: IDBValidKey[] = [];
      const nextFp = new Map<IDBValidKey, unknown>();

      for (const [k, v] of curr.entries()) {
        const fp = fingerprint(name, v);
        nextFp.set(k, fp);
        if (!prev.has(k) || prev.get(k) !== fp) {
          puts.push([k, v]);
        }
      }
      for (const k of prev.keys()) {
        if (!curr.has(k)) deletes.push(k);
      }

      if (puts.length > 0 || deletes.length > 0) {
        patches[name] = { puts, deletes };
        touchedStores.push(name);
        nextFingerprints.set(name, nextFp);
      }
    }

    for (const name of ARRAY_STORES) {
      const prev = fingerprints.get(name)!;
      const curr = Array.isArray(state[name]) ? (state[name] as unknown[]) : [];
      const puts: [IDBValidKey, unknown][] = [];
      const deletes: IDBValidKey[] = [];
      const nextFp = new Map<IDBValidKey, unknown>();

      for (let i = 0; i < curr.length; i++) {
        const v = curr[i];
        const fp = fingerprint(name, v);
        nextFp.set(i, fp);
        if (!prev.has(i) || prev.get(i) !== fp) {
          puts.push([i, v]);
        }
      }
      for (const k of prev.keys()) {
        if (typeof k === "number" && k >= curr.length) deletes.push(k);
      }

      if (puts.length > 0 || deletes.length > 0) {
        patches[name] = { puts, deletes };
        touchedStores.push(name);
        nextFingerprints.set(name, nextFp);
      }
    }

    const extra = extractExtra(state);
    const nextMetaFp = metaFingerprint(state.shopProfile, state.nextIds, extra);
    const metaChanged = nextMetaFp !== committedMetaFp;

    return { patches, touchedStores, nextFingerprints, metaChanged, nextMetaFp, state, extra };
  };

  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(() => storage.withLock(fn));
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  const repo = new Proxy(memory, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || typeof prop !== "string") return value;
      if (prop === "exportState" || prop === "importState") {
        return (value as (...a: unknown[]) => unknown).bind(target);
      }
      if (isReadOnlyCall(prop)) {
        return async (...args: unknown[]) => {
          await queue;
          await sync();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (...args: unknown[]) =>
        runExclusive(async () => {
          await doSync();
          let result: unknown;
          try {
            result = await (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (err) {
            // Force a clean reload on the next op in case the failed call partially mutated memory.
            localRev = -1;
            throw err;
          }
          const diff = computeDiff();
          if (diff.touchedStores.length > 0 || diff.metaChanged) {
            const nextRev = Math.max(0, localRev) + 1;
            const nextRecent = [
              ...recentChanges.slice(-(RECENT_CHANGES_LIMIT - 1)),
              { rev: nextRev, stores: diff.touchedStores },
            ];
            const nextMeta: RepoMeta = {
              rev: nextRev,
              shopProfile: diff.state.shopProfile ?? null,
              nextIds: { ...((diff.state.nextIds as Record<string, number>) ?? {}) },
              recentChanges: nextRecent,
              ...(diff.extra ? { extra: diff.extra } : {}),
            };
            await storage.commit(diff.patches, nextMeta);
            for (const [name, fp] of diff.nextFingerprints.entries()) {
              fingerprints.set(name, fp);
            }
            committedMetaFp = diff.nextMetaFp;
            localRev = nextRev;
            recentChanges = nextRecent;
            if (broadcast) {
              broadcastTabEvent({ type: "mutated", rev: nextRev, method: prop });
            }
            for (const listener of listeners) listener(prop);
          }
          return result;
        });
    },
  }) as unknown as BillingRepository;

  return {
    repo,
    memory,
    flush: () => queue,
    sync: async () => {
      await queue;
      await sync();
    },
    onMutation(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async isEmpty() {
      await queue;
      await sync();
      return (await memory.getShopProfile()) === null;
    },
  };
}

/**
 * Migrate any existing v1 single-blob `"repo.state"` into v2 record-level
 * object stores. Safe to call from multiple tabs concurrently (serialized by
 * `withTxLock`).
 */
export async function migrateLegacyBlobIfNeeded(storage: RecordStorage): Promise<boolean> {
  if (!storage.readLegacyBlob) return false;
  return storage.withLock(async () => {
    const existingMeta = await storage.getMeta();
    if (existingMeta) return false;
    const legacy = await storage.readLegacyBlob!();
    if (!legacy) return false;
    const patches = buildFullPatches(legacy, true);
    const extra = extractExtra(legacy);
    const meta: RepoMeta = {
      rev: 1,
      shopProfile: legacy.shopProfile ?? null,
      nextIds: { ...((legacy.nextIds as Record<string, number>) ?? {}) },
      recentChanges: [],
      ...(extra ? { extra } : {}),
    };
    await storage.commit(patches, meta, [STATE_KEY]);
    return true;
  });
}

export async function openPersistedRepository(): Promise<PersistedRepository> {
  const storage = createIdbRecordStorage();
  await migrateLegacyBlobIfNeeded(storage);
  const persisted = persistRecordRepository(new MemoryRepository(), storage, { broadcast: true });
  await persisted.sync();
  return persisted;
}

/** Replace this browser's shop data (restore). The caller reloads the page. */
export async function writeRepositoryState(state: MemoryState): Promise<void> {
  await withTxLock(async () => {
    const prev = await idbGet<RepoMeta>(META_KEY);
    const patches = buildFullPatches(state, true);
    const extra = extractExtra(state);
    const meta: RepoMeta = {
      rev: (prev?.rev ?? 0) + 1,
      shopProfile: state.shopProfile ?? null,
      nextIds: { ...((state.nextIds as Record<string, number>) ?? {}) },
      recentChanges: [],
      ...(extra ? { extra } : {}),
    };
    await idbCommitPatches(patches, [[META_KEY, meta]], [STATE_KEY]);
  });
  broadcastTabEvent({ type: "restored" });
}
