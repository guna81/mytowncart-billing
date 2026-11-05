// SPDX-License-Identifier: Apache-2.0
/**
 * Thin typed wrappers around the desktop shell's Tauri commands.
 * The web UI never touches SQL or the keychain directly.
 */

export interface DbStatus {
  dbPath: string;
  schemaVersion: number;
  latestVersion: number;
  helloRows: number;
}

export interface HelloResult {
  helloRows: number;
}

export function isInTauri(): boolean {
  return (
    (window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__ !== undefined
  );
}

async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export function dbStatus(): Promise<DbStatus> {
  return invokeCmd<DbStatus>("db_status");
}

export function dbHello(): Promise<HelloResult> {
  return invokeCmd<HelloResult>("db_hello");
}

export function keychainSet(key: string, value: string): Promise<void> {
  return invokeCmd<void>("keychain_set", { key, value });
}

export function keychainGet(key: string): Promise<string | null> {
  return invokeCmd<string | null>("keychain_get", { key });
}

export function keychainDelete(key: string): Promise<void> {
  return invokeCmd<void>("keychain_delete", { key });
}
