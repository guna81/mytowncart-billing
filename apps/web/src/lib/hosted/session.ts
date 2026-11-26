// SPDX-License-Identifier: Apache-2.0
/** Hosted-mode session state shared by the gate and the settings panel. */
import { backupNow, getCloudBackupStatus } from "./cloudBackup";
import { idbClearAll, idbGet, idbSet } from "./idb";
import type { PersistedRepository } from "./persistedRepository";

/** The MyTownCart seller whose shop data this browser holds. */
const OWNER_KEY = "owner.sellerId";
const DEMO_FLAG = "mtc.hosted.demo";

let persisted: PersistedRepository | null = null;

export function setHostedRepository(next: PersistedRepository | null): void {
  persisted = next;
}

export function getHostedRepository(): PersistedRepository | null {
  return persisted;
}

export async function dataOwner(): Promise<string | null> {
  return (await idbGet<string>(OWNER_KEY)) ?? null;
}

export async function setDataOwner(sellerId: string): Promise<void> {
  await idbSet(OWNER_KEY, sellerId);
}

export function isDemo(): boolean {
  try {
    return sessionStorage.getItem(DEMO_FLAG) === "1";
  } catch {
    return false;
  }
}

export function setDemo(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(DEMO_FLAG, "1");
    else sessionStorage.removeItem(DEMO_FLAG);
  } catch {
    // Private mode without sessionStorage: demo simply ends on reload.
  }
}

/**
 * Sign out on a shared computer: make a final backup if anything is not yet
 * in the cloud, then remove this shop's data, token and keys from the
 * browser. Returns false (and removes nothing) when that backup fails.
 */
export async function signOutAndWipe(): Promise<boolean> {
  if (persisted && getCloudBackupStatus().pending) {
    const ok = await backupNow(persisted);
    if (!ok) return false;
  }
  await idbClearAll();
  setDemo(false);
  window.location.reload();
  return true;
}
