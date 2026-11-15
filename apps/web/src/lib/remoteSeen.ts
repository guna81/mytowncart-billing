// SPDX-License-Identifier: Apache-2.0
/**
 * Last catalogue snapshot read from the marketplace, kept in app settings so
 * the reconcile view works right after a restart, before the next sync run.
 */
import type { BillingRepository, RemoteItemLink } from "@mytowncart-billing/storage";
import { getRepository } from "./repository";

const KEY = "remote.seen";
/** Older snapshots are unhelpful; the next sync refreshes them anyway. */
const MAX_AGE_MS = 7 * 86_400_000;

interface Snapshot {
  version: 2;
  at: string;
  items: RemoteItemLink[];
}

export async function saveRemoteSeen(
  items: readonly RemoteItemLink[], now: Date, repo: BillingRepository = getRepository(),
): Promise<void> {
  const snapshot: Snapshot = { version: 2, at: now.toISOString(), items: [...items] };
  await repo.setAppSetting(KEY, JSON.stringify(snapshot));
}

/** A successful manual publish makes the previous catalogue snapshot obsolete. */
export async function invalidateRemoteSeen(repo: BillingRepository = getRepository()): Promise<void> {
  await repo.setAppSetting(KEY, "");
}

/** Null means no usable snapshot; an empty map is a successfully read empty catalogue. */
export async function loadRemoteSeen(
  now: Date, repo: BillingRepository = getRepository(),
): Promise<Map<string, RemoteItemLink> | null> {
  try {
    const raw = await repo.getAppSetting(KEY);
    if (raw === null) return null;
    const snapshot = JSON.parse(raw) as Snapshot;
    const at = Date.parse(snapshot.at);
    // Older snapshots may have been truncated by the former pagination contract.
    if (snapshot.version !== 2 || !Number.isFinite(at) || now.getTime() - at > MAX_AGE_MS || !Array.isArray(snapshot.items)) return null;
    if (!snapshot.items.every((i) => i !== null && typeof i === "object" &&
      typeof i.externalId === "string" && typeof i.stockUnits === "number" && Number.isFinite(i.stockUnits) &&
      typeof i.pricePaise === "number" && Number.isFinite(i.pricePaise) && typeof i.remoteHash === "string")) return null;
    return new Map(snapshot.items.map((i) => [i.externalId, i]));
  } catch {
    return null;
  }
}
