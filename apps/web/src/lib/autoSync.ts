// SPDX-License-Identifier: Apache-2.0
/**
 * Global background auto-sync manager for MyTownCart Billing.
 * Periodically syncs products and stock counts to and from MyTownCart marketplace,
 * and handles debounced immediate syncs after sales, restocks, or item changes.
 */

import { useEffect, useRef, useState } from "react";
import { currentToken } from "./connection";
import { getConnector } from "./marketplace";
import { getRepository, isInTauri, isLanServer } from "./repository";
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
/** Full catalog reconciliation is independent of the stock polling interval. */
export const CATALOG_REFRESH_MS = 15 * 60_000;

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
    // Keep existing items in sync by default; adding all items requires opt-in.
    return { intervalMin: normaliseIntervalMin(interval), details: details !== "0", list: list === "1" };
  } catch {
    return { intervalMin: DEFAULT_SYNC_INTERVAL_MIN, details: true, list: false };
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
let reconciling = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// In-memory by design: a restart always performs a fresh full reconciliation.
let lastCatalogSuccess: number | null = null;
let stockRetryTimer: ReturnType<typeof setTimeout> | null = null;
let stockRetryAt = 0;
// Periodic work takes precedence over a pull retry, then event-driven pushes.
let queuedSync: "stock" | "pull" | "full" | null = null;

function requestBackgroundSync(kind: "stock" | "pull" | "full"): void {
  if (!useAppStore.getState().autoSyncEnabled) return;
  if (inFlightSync || reconciling) {
    if (kind === "full" || (kind === "pull" && queuedSync !== "full") || queuedSync === null) queuedSync = kind;
    return;
  }
  const elapsed = lastCatalogSuccess === null ? Infinity : Date.now() - lastCatalogSuccess;
  const catalogDue = elapsed < 0 || elapsed >= CATALOG_REFRESH_MS;
  void runAutoSync({
    stockOnly: kind !== "full" || !catalogDue,
    pullStock: kind !== "stock" && Date.now() >= stockRetryAt,
  });
}

function scheduleStockRetry(seconds: number): void {
  stockRetryAt = Date.now() + Math.max(1, seconds) * 1000;
  if (stockRetryTimer) clearTimeout(stockRetryTimer);
  stockRetryTimer = setTimeout(() => {
    stockRetryTimer = null;
    requestBackgroundSync("pull");
  }, stockRetryAt - Date.now());
}

function flushQueuedSync(): void {
  const kind = queuedSync;
  queuedSync = null;
  if (kind) requestBackgroundSync(kind);
}

// LAN browsers have no host-wide ownership protocol. Do not let them start a
// sync or apply a reconciliation concurrently with the desktop's work.
async function acquireHostCoordination(): Promise<() => Promise<void>> {
  if (isLanServer() && !isInTauri()) {
    throw new Error("Sync and reconciliation are only available on the desktop host");
  }
  if (!isInTauri()) return async () => {};
  const { invoke } = await import("@tauri-apps/api/core");
  const token = await invoke<string>("acquire_sync_coordinator");
  return async () => { await invoke("release_sync_coordinator", { token }); };
}

/** Exclude sync while applying a reconciliation decision. */
export async function withReconciliationLock<T>(action: () => Promise<T>): Promise<T> {
  if (inFlightSync || reconciling) throw new Error("Sync or reconciliation is already in progress");
  reconciling = true;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireHostCoordination();
    return await action();
  } finally {
    try {
      await release?.();
    } finally {
      reconciling = false;
      flushQueuedSync();
    }
  }
}

export async function isAutoSyncConfigured(): Promise<boolean> {
  try {
    const raw = await getRepository().getAppSetting(AUTO_SYNC_SETTING_KEY);
    // Automatic sync requires an explicit opt-in.
    return raw === "1";
  } catch {
    return false;
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
  options: { force?: boolean; manual?: boolean; stockOnly?: boolean; pullStock?: boolean } = {},
): Promise<SyncOutcome | null> {
  if (inFlightSync || reconciling) return null;
  if (!syncAvailable()) return null;
  if (!currentToken()) return null;

  const state = useAppStore.getState();
  if (!options.force && !state.autoSyncEnabled) return null;

  inFlightSync = true;
  const setIsSyncing = useAppStore.getState().setIsSyncing;
  const bumpDataVersion = useAppStore.getState().bumpDataVersion;
  setIsSyncing(true);
  let release: (() => Promise<void>) | undefined;

  try {
    release = await acquireHostCoordination();
    const repo = getRepository();
    // Products made on MyTownCart itself: always on a manual sync, otherwise only
    // when the saved list is old (a full read can be many pages).
    const platformOnly = options.manual === true || (!options.stockOnly && (await platformOnlyIsStale(new Date())));
    const outcome = await runSync({
      repo,
      connector: getConnector(),
      now: () => new Date(),
      isApproved: () => true,
    }, {
      force: options.manual === true,
      stockOnly: options.stockOnly === true && options.manual !== true,
      pullStock: options.manual === true || (options.pullStock ?? options.stockOnly !== true),
      platformOnly,
      details: state.syncDetails,
      list: state.syncList,
    });

    if (outcome.retryAfterSeconds !== undefined) {
      scheduleStockRetry(outcome.retryAfterSeconds);
    } else if (options.manual || (options.pullStock ?? !options.stockOnly)) {
      if (outcome.problems.length === 0) {
        if (stockRetryTimer) clearTimeout(stockRetryTimer);
        stockRetryTimer = null;
        stockRetryAt = 0;
      }
    }

    // A successful narrow run cannot establish that a previous full-run error
    // has been resolved. Preserve those errors until the next full run.
    let previousProblems: string[] = [];
    let previousCatalogFailed = 0;
    if (options.stockOnly) {
      const previous = await repo.getAppSetting(SYNC_LAST_KEY);
      if (previous) {
        try {
          const parsed = JSON.parse(previous) as { outcome?: { problems?: unknown; catalogFailed?: unknown } };
          if (Array.isArray(parsed.outcome?.problems)) previousProblems = parsed.outcome.problems.filter((p): p is string => typeof p === "string");
          if (typeof parsed.outcome?.catalogFailed === "number") previousCatalogFailed = parsed.outcome.catalogFailed;
        } catch { /* Ignore an invalid saved status. */ }
      }
    }
    const savedOutcome = {
      ...outcome,
      problems: [...new Set([...previousProblems, ...outcome.problems])],
      catalogFailed: Math.max(previousCatalogFailed, outcome.catalogFailed),
      // A push or catalog-only run cannot resolve an outstanding pull delay.
      retryAfterSeconds: outcome.retryAfterSeconds ?? (stockRetryAt ? Math.max(1, Math.ceil((stockRetryAt - Date.now()) / 1000)) : undefined),
    };
    const record = { at: outcome.at, outcome: savedOutcome, stockRetryAt: stockRetryAt || undefined };
    await repo.setAppSetting(SYNC_LAST_KEY, JSON.stringify(record));
    if ((!options.stockOnly || options.manual) && outcome.problems.length === 0 && outcome.catalogFailed === 0) {
      lastCatalogSuccess = Date.now();
    }
    bumpDataVersion();
    return outcome;
  } catch (err) {
    if (options.manual) throw err;
    console.warn("[auto-sync] Background sync error:", err);
    return null;
  } finally {
    try {
      await release?.();
    } finally {
      inFlightSync = false;
      setIsSyncing(false);
      flushQueuedSync();
    }
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
    requestBackgroundSync("stock");
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
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Do not start the timer until all persisted scopes and the interval are loaded.
  useEffect(() => {
    if (!booted) {
      setSettingsLoaded(false);
      return;
    }
    let cancelled = false;
    void Promise.all([
      isAutoSyncConfigured(),
      loadSyncSettings(),
      getRepository().getAppSetting(SYNC_LAST_KEY).catch(() => null),
    ]).then(([enabled, s, saved]) => {
      if (cancelled) return;
      if (enabled && saved && !stockRetryAt) {
        try {
          const retryAt = (JSON.parse(saved) as { stockRetryAt?: unknown }).stockRetryAt;
          if (typeof retryAt === "number" && Number.isFinite(retryAt) && retryAt > Date.now()) {
            scheduleStockRetry((retryAt - Date.now()) / 1000);
          }
        } catch { /* Ignore an invalid saved status. */ }
      }
      setAutoSyncEnabled(enabled);
      useAppStore.getState().setSyncIntervalMin(s.intervalMin);
      useAppStore.getState().setSyncDetails(s.details);
      useAppStore.getState().setSyncList(s.list);
      setSettingsLoaded(true);
    });
    return () => { cancelled = true; };
  }, [booted, setAutoSyncEnabled]);

  // Periodic interval loop
  useEffect(() => {
    if (!booted || !settingsLoaded || !autoSyncEnabled || !syncAvailable()) return;

    // Run initial sync after a short delay on startup
    let initialTimer: ReturnType<typeof setTimeout> | null = null;
    if (!initialRunDone.current) {
      initialTimer = setTimeout(() => {
        initialRunDone.current = true;
        requestBackgroundSync("full");
      }, 5000);
    }

    const interval = setInterval(() => {
      requestBackgroundSync("full");
    }, intervalMin * 60_000);

    return () => {
      if (initialTimer) clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [booted, settingsLoaded, autoSyncEnabled, intervalMin]);
}
