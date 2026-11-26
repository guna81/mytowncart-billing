// SPDX-License-Identifier: Apache-2.0
/**
 * The hosted web app's repository (D2, D13): the in-memory adapter, with its
 * whole state written to IndexedDB after every change. A mutating call only
 * resolves once that write has committed, so "Bill saved" means saved on
 * this device. The cloud backup (cloudBackup.ts) is the off-device copy.
 *
 * One tab at a time (singleTab.ts): two tabs would each hold their own copy
 * in memory and overwrite each other's writes.
 */
import { MemoryRepository, type BillingRepository, type MemoryState } from "@mytowncart-billing/storage";
import { idbGet, idbSet } from "./idb";

export const STATE_KEY = "repo.state";

/** Calls that never change data; everything else is persisted after it resolves. */
const READ_ONLY = /^(list|get|read|find|lookup|verify|logout)/;

export type MutationListener = (method: string) => void;

export interface PersistedRepository {
  repo: BillingRepository;
  memory: MemoryRepository;
  /** Resolves once every change so far is committed to IndexedDB. */
  flush(): Promise<void>;
  onMutation(listener: MutationListener): () => void;
  /** True when this browser holds no shop yet (fresh install or cleared). */
  isEmpty(): Promise<boolean>;
}

export function isReadOnlyCall(method: string): boolean {
  return READ_ONLY.test(method);
}

export function persistRepository(
  memory: MemoryRepository,
  write: (state: MemoryState) => Promise<void>,
): PersistedRepository {
  const listeners = new Set<MutationListener>();
  let writing: Promise<void> | null = null;
  let dirty = false;

  const loop = async (): Promise<void> => {
    try {
      while (dirty) {
        dirty = false;
        await write(memory.exportState());
      }
    } finally {
      writing = null;
    }
  };

  const persist = (): Promise<void> => {
    dirty = true;
    if (!writing) writing = loop();
    return writing;
  };

  const repo = new Proxy(memory, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || typeof prop !== "string") return value;
      if (isReadOnlyCall(prop) || prop === "exportState" || prop === "importState") {
        return (value as (...a: unknown[]) => unknown).bind(target);
      }
      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => unknown).apply(target, args);
        await persist();
        for (const listener of listeners) listener(prop);
        return result;
      };
    },
  }) as unknown as BillingRepository;

  return {
    repo,
    memory,
    flush: () => (writing ?? Promise.resolve()),
    onMutation(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async isEmpty() {
      return (await memory.getShopProfile()) === null;
    },
  };
}

export async function openPersistedRepository(): Promise<PersistedRepository> {
  const memory = new MemoryRepository();
  const saved = await idbGet<MemoryState>(STATE_KEY);
  if (saved) memory.importState(saved);
  return persistRepository(memory, (state) => idbSet(STATE_KEY, state));
}

/** Replace this browser's shop data (restore). The caller reloads the page. */
export async function writeRepositoryState(state: MemoryState): Promise<void> {
  await idbSet(STATE_KEY, state);
}
