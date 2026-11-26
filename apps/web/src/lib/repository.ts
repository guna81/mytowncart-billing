// SPDX-License-Identifier: Apache-2.0
/**
 * Repository singleton. Inside the desktop shell the Tauri adapter (SQLite)
 * is used; in a plain browser — dev server, Playwright — the in-memory
 * adapter keeps the whole app usable (roadmap §8.1 test stack).
 */
import {
  HttpRepository,
  MemoryRepository,
  TauriRepository,
  type BillingRepository,
} from "@mytowncart-billing/storage";
import { isHosted } from "./hosted/mode";

export function isInTauri(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined
  );
}

export function isLanServer(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as { __MTC_LAN_SERVER__?: boolean }).__MTC_LAN_SERVER__ === true;
}

let repo: BillingRepository | null = null;

export function getRepository(): BillingRepository {
  if (!repo) {
    if (isHosted()) {
      // HostedGate installs the IndexedDB-backed (or demo) repository before
      // the app renders; reaching here means a screen rendered too early.
      throw new Error("hosted repository is not ready yet");
    }
    if (isInTauri()) {
      repo = new TauriRepository();
    } else if (isLanServer()) {
      repo = new HttpRepository(window.location.origin);
    } else {
      repo = new MemoryRepository();
    }
  }
  return repo!;
}

/** Install the adapter chosen at startup (hosted mode) — also the test hook. */
export function setRepository(next: BillingRepository | null): void {
  repo = next;
}

/** Test hook: swap the adapter (e.g. a fresh MemoryRepository per test). */
export const setRepositoryForTesting = setRepository;
