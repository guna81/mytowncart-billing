// SPDX-License-Identifier: Apache-2.0
/**
 * One open tab per browser (hosted mode). Each tab keeps the shop data in
 * memory and writes all of it to IndexedDB, so a second tab would silently
 * overwrite the first one's bills. A Web Lock held for the tab's lifetime
 * makes the second tab show "already open" instead.
 */

const LOCK_NAME = "mytowncart-billing-app";

let acquired: Promise<boolean> | null = null;

/** Idempotent per page: a second call (e.g. React StrictMode) reuses the first result. */
export function acquireAppLock(): Promise<boolean> {
  acquired ??= requestLock();
  return acquired;
}

function requestLock(): Promise<boolean> {
  const locks = (typeof navigator !== "undefined" ? navigator.locks : undefined) as LockManager | undefined;
  // Very old browsers: no way to coordinate; allow rather than lock the seller out.
  if (!locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    void locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return undefined;
      }
      resolve(true);
      // Held until the tab closes.
      return new Promise<void>(() => {});
    });
  });
}
