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

/** Test hook: swap the adapter (e.g. a fresh MemoryRepository per test). */
export function setRepositoryForTesting(next: BillingRepository | null): void {
  repo = next;
}
