// SPDX-License-Identifier: Apache-2.0
/**
 * Products that exist on MyTownCart but not in this app (created in the seller
 * app or admin). Read-only: kept in app settings from the last read so the
 * Overview works right after a restart. Refreshed on a manual sync and then
 * only occasionally, since a full read can span many pages.
 */
import type { PlatformProduct } from "@mytowncart-billing/connector-mytowncart";
import { getRepository } from "./repository";

const KEY = "remote.only";
/** Background syncs re-read at most this often; "Sync now" always re-reads. */
export const PLATFORM_ONLY_REFRESH_MS = 30 * 60_000;

export interface PlatformOnlySnapshot {
  at: string;
  items: PlatformProduct[];
}

export async function savePlatformOnly(items: readonly PlatformProduct[], now: Date): Promise<void> {
  const snapshot: PlatformOnlySnapshot = { at: now.toISOString(), items: [...items] };
  await getRepository().setAppSetting(KEY, JSON.stringify(snapshot));
}

export async function loadPlatformOnly(): Promise<PlatformOnlySnapshot | null> {
  const raw = await getRepository().getAppSetting(KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PlatformOnlySnapshot;
  } catch {
    return null;
  }
}

export async function platformOnlyIsStale(now: Date): Promise<boolean> {
  const snapshot = await loadPlatformOnly();
  return snapshot === null || now.getTime() - Date.parse(snapshot.at) > PLATFORM_ONLY_REFRESH_MS;
}

/** Drop products that were just pulled so the list updates before the next read. */
export async function removeFromPlatformOnly(productIds: readonly string[]): Promise<void> {
  const snapshot = await loadPlatformOnly();
  if (snapshot === null) return;
  const gone = new Set(productIds);
  await getRepository().setAppSetting(
    KEY,
    JSON.stringify({ ...snapshot, items: snapshot.items.filter((p) => !gone.has(p.productId)) }),
  );
}
