// SPDX-License-Identifier: Apache-2.0
/**
 * Last catalogue snapshot read from the marketplace, kept in app settings so
 * the reconcile view works right after a restart, before the next sync run.
 */
import type { RemoteItemLink } from "@mytowncart-billing/storage";
import { getRepository } from "./repository";

const KEY = "remote.seen";
/** Older snapshots are unhelpful; the next sync refreshes them anyway. */
const MAX_AGE_MS = 7 * 86_400_000;

interface Snapshot {
  at: string;
  items: RemoteItemLink[];
}

export async function saveRemoteSeen(items: readonly RemoteItemLink[], now: Date): Promise<void> {
  if (items.length === 0) return;
  const snapshot: Snapshot = { at: now.toISOString(), items: [...items] };
  await getRepository().setAppSetting(KEY, JSON.stringify(snapshot));
}

export async function loadRemoteSeen(now: Date): Promise<Map<string, RemoteItemLink>> {
  const raw = await getRepository().getAppSetting(KEY);
  if (raw === null) return new Map();
  try {
    const snapshot = JSON.parse(raw) as Snapshot;
    if (now.getTime() - Date.parse(snapshot.at) > MAX_AGE_MS) return new Map();
    return new Map(snapshot.items.map((i) => [i.externalId, i]));
  } catch {
    return new Map();
  }
}
