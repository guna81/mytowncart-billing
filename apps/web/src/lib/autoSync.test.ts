// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@mytowncart-billing/storage";
import {
  AUTO_SYNC_SETTING_KEY,
  isAutoSyncConfigured,
  loadSyncSettings,
  setSyncScopeSetting,
  normaliseIntervalMin,
  setSyncIntervalSetting,
  runAutoSync,
  setAutoSyncSetting,
  triggerImmediateSync,
  withReconciliationLock,
  useAutoSync,
} from "./autoSync";
import { useAppStore } from "../store/appStore";

// Mock repository
let repo = new MemoryRepository();
let lan = false;
const host = vi.hoisted(() => ({ held: false, fail: false }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command === "acquire_sync_coordinator") {
      if (host.fail || host.held) throw new Error("host busy");
      host.held = true;
      return "1";
    }
    if (command === "release_sync_coordinator") host.held = false;
  },
}));
vi.mock("./repository", () => ({
  getRepository: () => repo,
  isInTauri: () => !lan,
  isLanServer: () => lan,
}));

let mockToken: string | null = "test-token";
vi.mock("./connection", () => ({
  currentToken: () => mockToken,
}));

let runSyncCalled = false;
const calls = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>>, pending: null as Promise<void> | null, retryAfterSeconds: undefined as number | undefined, problems: [] as string[] }));
vi.mock("./syncEngine", () => ({
  syncAvailable: () => true,
  runSync: async (_deps: unknown, options: Record<string, unknown>) => {
    runSyncCalled = true;
    calls.options.push(options);
    if (calls.pending) await calls.pending;
    return {
      at: "2026-11-10T00:00:00.000Z",
      pushedMoves: 1,
      pulledMoves: 0,
      restocked: 0,
      catalogSent: 1,
      catalogFailed: 0,
      orders: 0,
      problems: [...calls.problems],
      retryAfterSeconds: calls.retryAfterSeconds,
    };
  },
}));

vi.mock("./marketplace", () => ({
  getConnector: () => ({}),
}));

describe("autoSync", () => {
  beforeEach(() => {
    repo = new MemoryRepository();
    lan = false;
    host.held = false;
    host.fail = false;
    mockToken = "test-token";
    runSyncCalled = false;
    calls.options = [];
    calls.pending = null;
    calls.problems = [];
    calls.retryAfterSeconds = undefined;
    useAppStore.getState().setAutoSyncEnabled(true);
    useAppStore.getState().setIsSyncing(false);
  });

  it("isAutoSyncConfigured defaults to false when setting is absent", async () => {
    const configured = await isAutoSyncConfigured();
    expect(configured).toBe(false);
  });

  it("isAutoSyncConfigured returns false when setting is '0'", async () => {
    await repo.setAppSetting(AUTO_SYNC_SETTING_KEY, "0");
    const configured = await isAutoSyncConfigured();
    expect(configured).toBe(false);
  });

  it("setAutoSyncSetting updates repository and app store", async () => {
    await setAutoSyncSetting(false);
    expect(await repo.getAppSetting(AUTO_SYNC_SETTING_KEY)).toBe("0");
    expect(useAppStore.getState().autoSyncEnabled).toBe(false);

    await setAutoSyncSetting(true);
    expect(await repo.getAppSetting(AUTO_SYNC_SETTING_KEY)).toBe("1");
    expect(useAppStore.getState().autoSyncEnabled).toBe(true);
    expect(await isAutoSyncConfigured()).toBe(true);
  });

  it("excludes sync and repeated reconciliation and releases the lock on failure", async () => {
    await expect(withReconciliationLock(async () => {
      expect(await runAutoSync()).toBeNull();
      await expect(withReconciliationLock(async () => {})).rejects.toThrow();
      throw new Error("failure");
    })).rejects.toThrow("failure");
    expect(await runAutoSync()).not.toBeNull();
  });

  it("fails closed when host coordination is unavailable", async () => {
    host.fail = true;
    await expect(runAutoSync({ manual: true })).rejects.toThrow("host busy");
    await expect(withReconciliationLock(async () => {})).rejects.toThrow("host busy");
    expect(runSyncCalled).toBe(false);
  });

  it("does not sync or reconcile from LAN browsers", async () => {
    lan = true;
    await expect(runAutoSync({ manual: true })).rejects.toThrow("desktop host");
    await expect(withReconciliationLock(async () => {})).rejects.toThrow("desktop host");
    expect(runSyncCalled).toBe(false);
  });

  it("runAutoSync runs sync when enabled and connected", async () => {
    const outcome = await runAutoSync();
    expect(outcome).not.toBeNull();
    expect(runSyncCalled).toBe(true);
    expect(outcome?.pushedMoves).toBe(1);
  });

  it("runAutoSync skips when autoSyncEnabled is false and not forced", async () => {
    useAppStore.getState().setAutoSyncEnabled(false);
    const outcome = await runAutoSync();
    expect(outcome).toBeNull();
    expect(runSyncCalled).toBe(false);

    // Can still be forced
    const forcedOutcome = await runAutoSync({ force: true });
    expect(forcedOutcome).not.toBeNull();
    expect(runSyncCalled).toBe(true);
  });

  it("runAutoSync skips when disconnected", async () => {
    mockToken = null;
    const outcome = await runAutoSync();
    expect(outcome).toBeNull();
    expect(runSyncCalled).toBe(false);
  });

  it("triggerImmediateSync schedules debounced sync", async () => {
    vi.useFakeTimers();
    try {
      triggerImmediateSync();
      expect(runSyncCalled).toBe(false);

      vi.advanceTimersByTime(2900);
      expect(runSyncCalled).toBe(false);

      await vi.advanceTimersByTimeAsync(200);
      expect(runSyncCalled).toBe(true);
      expect(calls.options[0]).toMatchObject({ stockOnly: true, pullStock: false, platformOnly: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces events during an in-flight run into one follow-up", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    calls.pending = new Promise<void>((resolve) => { release = resolve; });
    try {
      const first = runAutoSync();
      await vi.advanceTimersByTimeAsync(0);
      triggerImmediateSync();
      triggerImmediateSync();
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls.options).toHaveLength(1);
      calls.pending = null;
      release();
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.options).toHaveLength(2);
      expect(calls.options[1]).toMatchObject({ stockOnly: true, pullStock: false });
    } finally {
      calls.pending = null;
      release();
      vi.useRealTimers();
    }
  });

  it("drops queued work if auto-sync is disabled before the run finishes", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    calls.pending = new Promise<void>((resolve) => { release = resolve; });
    try {
      const first = runAutoSync();
      await vi.advanceTimersByTimeAsync(0);
      triggerImmediateSync();
      await vi.advanceTimersByTimeAsync(3000);
      useAppStore.getState().setAutoSyncEnabled(false);
      calls.pending = null;
      release();
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.options).toHaveLength(1);
    } finally {
      calls.pending = null;
      release();
      vi.useRealTimers();
    }
  });

  it("retains events that arrive during reconciliation", async () => {
    vi.useFakeTimers();
    try {
      await withReconciliationLock(async () => {
        triggerImmediateSync();
        await vi.advanceTimersByTimeAsync(3000);
        expect(calls.options).toHaveLength(0);
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.options).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for all persisted settings before scheduling the initial full run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await repo.setAppSetting(AUTO_SYNC_SETTING_KEY, "1");
    let release!: (value: string | null) => void;
    const delayed = new Promise<string | null>((resolve) => { release = resolve; });
    const getSetting = repo.getAppSetting.bind(repo);
    vi.spyOn(repo, "getAppSetting").mockImplementation((key) =>
      key === "sync.details_enabled" ? delayed : getSetting(key));
    const container = document.createElement("div");
    const root = createRoot(container);
    const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    function TestHook() { useAutoSync(); return null; }
    try {
      useAppStore.getState().setBooted(true);
      await act(async () => { root.render(createElement(TestHook)); });
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(calls.options).toHaveLength(0);
      await act(async () => { release("0"); await delayed; });
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(calls.options).toHaveLength(1);
      expect(calls.options[0]).toMatchObject({ details: false, stockOnly: false, pullStock: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(calls.options[1]).toMatchObject({ stockOnly: true, pullStock: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(14 * 60_000); });
      expect(calls.options.filter((options) => options.stockOnly === false)).toHaveLength(2);
    } finally {
      await act(async () => { root.unmount(); });
      useAppStore.getState().setBooted(false);
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
      vi.useRealTimers();
    }
  });

  it("retries a deferred stock pull at the requested time, not on intervening events", async () => {
    vi.useFakeTimers();
    try {
      calls.retryAfterSeconds = 10;
      await runAutoSync({ manual: true, force: true });
      calls.retryAfterSeconds = undefined;
      triggerImmediateSync();
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls.options[1]).toMatchObject({ stockOnly: true, pullStock: false });
      const waiting = JSON.parse((await repo.getAppSetting("sync.last"))!);
      expect(waiting.outcome.retryAfterSeconds).toBe(7);
      expect(waiting.stockRetryAt).toBe(Date.now() + 7000);
      await vi.advanceTimersByTimeAsync(6999);
      expect(calls.options).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls.options).toHaveLength(3);
      expect(calls.options[2]).toMatchObject({ stockOnly: true, pullStock: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves previous errors when a stock-only run succeeds", async () => {
    calls.problems = ["catalog failed"];
    await runAutoSync();
    calls.problems = [];
    await runAutoSync({ stockOnly: true });
    const saved = JSON.parse((await repo.getAppSetting("sync.last"))!);
    expect(saved.outcome.problems).toEqual(["catalog failed"]);
  });

  it("sync settings default to 2 minutes and persist changes", async () => {
    expect(await loadSyncSettings()).toEqual({ intervalMin: 2, details: true, list: false });
    await setSyncIntervalSetting(15);
    expect(await loadSyncSettings()).toEqual({ intervalMin: 15, details: true, list: false });
    expect(useAppStore.getState().syncIntervalMin).toBe(15);
    await setSyncScopeSetting("list", true);
    expect((await loadSyncSettings()).list).toBe(true);
  });

  it("never allows an interval below the server's 2 minute floor", () => {
    expect(normaliseIntervalMin(1)).toBe(2);
    expect(normaliseIntervalMin("junk")).toBe(2);
    expect(normaliseIntervalMin("5")).toBe(5);
  });

  it("a background run is skipped when auto-sync is off, but a manual run still works", async () => {
    useAppStore.getState().setAutoSyncEnabled(false);
    expect(await runAutoSync()).toBeNull();
    expect(runSyncCalled).toBe(false);
    expect(await runAutoSync({ force: true, manual: true })).not.toBeNull();
    expect(runSyncCalled).toBe(true);
  });
});
