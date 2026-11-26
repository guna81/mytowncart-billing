// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-tab notifications for hosted mode (BroadcastChannel).
 *
 * Data consistency comes from record-level IndexedDB transactions + short
 * Web Locks in `persistedRepository.ts`; this channel lets other open tabs
 * react immediately to mutations, cloud-backup status changes, restores,
 * sign-in, and sign-out.
 */

const CHANNEL_NAME = "mytowncart-billing-sync";

export const TAB_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export type TabEvent =
  | { type: "mutated"; rev: number; method: string }
  | { type: "backup_status"; lastSuccessAt: string | null; pending: boolean }
  | { type: "signed_in" }
  | { type: "signed_out" }
  | { type: "restored" }
  | { type: "token_refreshed" };

export type TabMessage = TabEvent & { tabId: string };

let channel: BroadcastChannel | null = null;
const listeners = new Set<(msg: TabMessage) => void>();

function ensureChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<TabMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object" || msg.tabId === TAB_ID) return;
      for (const fn of listeners) fn(msg);
    };
  }
  return channel;
}

export function broadcastTabEvent(msg: TabEvent): void {
  try {
    ensureChannel()?.postMessage({ ...msg, tabId: TAB_ID });
  } catch {
    // Ignore when BroadcastChannel is unavailable or closed.
  }
}

export function subscribeTabEvents(listener: (msg: TabMessage) => void): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
