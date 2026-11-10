// SPDX-License-Identifier: Apache-2.0
/**
 * Global background auto-sync manager for MyTownCart Billing.
 * Periodically syncs products and stock counts to and from MyTownCart marketplace,
 * and handles debounced immediate syncs after sales, restocks, or item changes.
 */

import { useEffect, useRef } from "react";
import { currentToken } from "./connection";
import { getConnector } from "./marketplace";
import { getRepository } from "./repository";
import { runSync, syncAvailable, type SyncOutcome } from "./syncEngine";
import { useAppStore } from "../store/appStore";

export const AUTO_SYNC_SETTING_KEY = "sync.auto_enabled";
export const SYNC_LAST_KEY = "sync.last";
export const AUTO_SYNC_INTERVAL_MS = 2 * 60_000; // 2 minutes

let inFlightSync = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export async function isAutoSyncConfigured(): Promise<boolean> {
  try {
    const raw = await getRepository().getAppSetting(AUTO_SYNC_SETTING_KEY);
    // Default to true unless explicitly disabled ("0")
    return raw !== "0";
  } catch {
    return true;
  }
}

export async function setAutoSyncSetting(enabled: boolean): Promise<void> {
  const repo = getRepository();
  await repo.setAppSetting(AUTO_SYNC_SETTING_KEY, enabled ? "1" : "0");
  useAppStore.getState().setAutoSyncEnabled(enabled);
}

/**
 * Execute a sync run if auto-sync is allowed (or forced) and not currently running.
 */
export async function runAutoSync(options: { force?: boolean } = {}): Promise<SyncOutcome | null> {
  if (inFlightSync) return null;
  if (!syncAvailable()) return null;
  if (!currentToken()) return null;

  const enabled = useAppStore.getState().autoSyncEnabled;
  if (!options.force && !enabled) return null;

  inFlightSync = true;
  const setIsSyncing = useAppStore.getState().setIsSyncing;
  const bumpDataVersion = useAppStore.getState().bumpDataVersion;
  setIsSyncing(true);

  try {
    const repo = getRepository();
    const outcome = await runSync({
      repo,
      connector: getConnector(),
      now: () => new Date(),
      isApproved: () => true,
    });

    const record = { at: outcome.at, outcome };
    await repo.setAppSetting(SYNC_LAST_KEY, JSON.stringify(record));
    bumpDataVersion();
    return outcome;
  } catch (err) {
    console.warn("[auto-sync] Background sync error:", err);
    return null;
  } finally {
    inFlightSync = false;
    setIsSyncing(false);
  }
}

/**
 * Trigger an immediate sync run debounced by 3 seconds.
 * Useful after ringing up a bill, editing an item, or auditing stock.
 */
export function triggerImmediateSync(): void {
  if (!useAppStore.getState().autoSyncEnabled) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runAutoSync();
  }, 3000);
}

/**
 * React hook mounted at application root to keep background auto-sync active.
 */
export function useAutoSync(): void {
  const autoSyncEnabled = useAppStore((s) => s.autoSyncEnabled);
  const setAutoSyncEnabled = useAppStore((s) => s.setAutoSyncEnabled);
  const booted = useAppStore((s) => s.booted);
  const initialRunDone = useRef(false);

  // Load persisted setting once booted
  useEffect(() => {
    if (!booted) return;
    void isAutoSyncConfigured().then((enabled) => {
      setAutoSyncEnabled(enabled);
    });
  }, [booted, setAutoSyncEnabled]);

  // Periodic interval loop
  useEffect(() => {
    if (!booted || !autoSyncEnabled || !syncAvailable()) return;

    // Run initial sync after a short delay on startup
    let initialTimer: ReturnType<typeof setTimeout> | null = null;
    if (!initialRunDone.current) {
      initialRunDone.current = true;
      initialTimer = setTimeout(() => {
        void runAutoSync();
      }, 5000);
    }

    const interval = setInterval(() => {
      void runAutoSync();
    }, AUTO_SYNC_INTERVAL_MS);

    return () => {
      if (initialTimer) clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [booted, autoSyncEnabled]);
}
