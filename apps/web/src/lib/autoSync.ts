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
import { platformOnlyIsStale } from "./platformOnly";
import { runSync, syncAvailable, type SyncOutcome } from "./syncEngine";
import { useAppStore } from "../store/appStore";

export const AUTO_SYNC_SETTING_KEY = "sync.auto_enabled";
export const SYNC_LAST_KEY = "sync.last";
export const SYNC_INTERVAL_SETTING_KEY = "sync.interval_min";
export const SYNC_DETAILS_SETTING_KEY = "sync.details_enabled";
export const SYNC_LIST_SETTING_KEY = "sync.list_enabled";
/** Server enforces a 120 s floor (`min_poll_interval`); never go below it. */
export const SYNC_INTERVAL_CHOICES = [2, 5, 15] as const;
export const DEFAULT_SYNC_INTERVAL_MIN = 2;
export const AUTO_SYNC_INTERVAL_MS = DEFAULT_SYNC_INTERVAL_MIN * 60_000;

export function normaliseIntervalMin(raw: string | number | null): number {
  const n = Number(raw);
  return (SYNC_INTERVAL_CHOICES as readonly number[]).includes(n) ? n : DEFAULT_SYNC_INTERVAL_MIN;
}

export async function loadSyncSettings(): Promise<{
  intervalMin: number;
  details: boolean;
  list: boolean;
}> {
  try {
    const repo = getRepository();
    const [interval, details, list] = await Promise.all([
      repo.getAppSetting(SYNC_INTERVAL_SETTING_KEY),
      repo.getAppSetting(SYNC_DETAILS_SETTING_KEY),
      repo.getAppSetting(SYNC_LIST_SETTING_KEY),
    ]);
    // Both default to on unless explicitly switched off ("0").
    return { intervalMin: normaliseIntervalMin(interval), details: details !== "0", list: list !== "0" };
  } catch {
    return { intervalMin: DEFAULT_SYNC_INTERVAL_MIN, details: true, list: true };
  }
}

export async function setSyncScopeSetting(which: "details" | "list", enabled: boolean): Promise<void> {
  const key = which === "details" ? SYNC_DETAILS_SETTING_KEY : SYNC_LIST_SETTING_KEY;
  await getRepository().setAppSetting(key, enabled ? "1" : "0");
  const store = useAppStore.getState();
  if (which === "details") store.setSyncDetails(enabled);
  else store.setSyncList(enabled);
}

export async function setSyncIntervalSetting(minutes: number): Promise<void> {
  const value = normaliseIntervalMin(minutes);
  await getRepository().setAppSetting(SYNC_INTERVAL_SETTING_KEY, String(value));
  useAppStore.getState().setSyncIntervalMin(value);
}

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
export async function runAutoSync(
  options: { force?: boolean; manual?: boolean } = {},
): Promise<SyncOutcome | null> {
  if (inFlightSync) return null;
  if (!syncAvailable()) return null;
  if (!currentToken()) return null;

  const state = useAppStore.getState();
  if (!options.force && !state.autoSyncEnabled) return null;

  inFlightSync = true;
  const setIsSyncing = useAppStore.getState().setIsSyncing;
  const bumpDataVersion = useAppStore.getState().bumpDataVersion;
  setIsSyncing(true);

  try {
    const repo = getRepository();
    // Products made on MyTownCart itself: always on a manual sync, otherwise only
    // when the saved list is old (a full read can be many pages).
    const platformOnly = options.manual === true || (await platformOnlyIsStale(new Date()));
    const outcome = await runSync({
      repo,
      connector: getConnector(),
      now: () => new Date(),
      isApproved: () => true,
    }, {
      force: options.manual === true,
      platformOnly,
      details: state.syncDetails,
      list: state.syncList,
    });

    const record = { at: outcome.at, outcome };
    await repo.setAppSetting(SYNC_LAST_KEY, JSON.stringify(record));
    bumpDataVersion();
    return outcome;
  } catch (err) {
    if (options.manual) throw err;
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
  const intervalMin = useAppStore((s) => s.syncIntervalMin);
  const initialRunDone = useRef(false);

  // Load persisted setting once booted
  useEffect(() => {
    if (!booted) return;
    void isAutoSyncConfigured().then((enabled) => {
      setAutoSyncEnabled(enabled);
    });
    void loadSyncSettings().then((s) => {
      useAppStore.getState().setSyncIntervalMin(s.intervalMin);
      useAppStore.getState().setSyncDetails(s.details);
      useAppStore.getState().setSyncList(s.list);
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
    }, intervalMin * 60_000);

    return () => {
      if (initialTimer) clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [booted, autoSyncEnabled, intervalMin]);
}
