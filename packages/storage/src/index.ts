// SPDX-License-Identifier: Apache-2.0
/**
 * `@mytowncart-billing/storage` — repository interfaces + adapters
 * (roadmap §8.1). The SQLite-backed adapter talks to the Rust shell via
 * Tauri commands; the in-memory adapter implements the same semantics for
 * tests and plain-browser dev. An IndexedDB adapter may follow for the
 * deferred demo PWA (D2).
 */

export * from "./types";
export * from "./repository";
export { TauriRepository, type InvokeFn } from "./tauri";
export { MemoryRepository, type MemoryState } from "./memory";
export { decodeMemoryState, encodeMemoryState, isWebStateBackup, WEB_STATE_MAGIC } from "./memoryState";
export { HttpRepository, createHttpInvoker, resolveAccessKey } from "./http";
export * from "./seed";

export * from "./ledger";
export { getSessionToken, setSessionToken } from "./session";
