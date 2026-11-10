// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@mytowncart-billing/storage";
import {
  AUTO_SYNC_SETTING_KEY,
  isAutoSyncConfigured,
  runAutoSync,
  setAutoSyncSetting,
  triggerImmediateSync,
} from "./autoSync";
import { useAppStore } from "../store/appStore";

// Mock repository
let repo = new MemoryRepository();
vi.mock("./repository", () => ({
  getRepository: () => repo,
  isInTauri: () => true,
  isLanServer: () => false,
}));

let mockToken: string | null = "test-token";
vi.mock("./connection", () => ({
  currentToken: () => mockToken,
}));

let runSyncCalled = false;
vi.mock("./syncEngine", () => ({
  syncAvailable: () => true,
  runSync: () => {
    runSyncCalled = true;
    return Promise.resolve({
      at: "2026-11-10T00:00:00.000Z",
      pushedMoves: 1,
      pulledMoves: 0,
      restocked: 0,
      catalogSent: 1,
      catalogFailed: 0,
      orders: 0,
      problems: [],
    });
  },
}));

vi.mock("./marketplace", () => ({
  getConnector: () => ({}),
}));

describe("autoSync", () => {
  beforeEach(() => {
    repo = new MemoryRepository();
    mockToken = "test-token";
    runSyncCalled = false;
    useAppStore.getState().setAutoSyncEnabled(true);
    useAppStore.getState().setIsSyncing(false);
  });

  it("isAutoSyncConfigured defaults to true when setting is absent", async () => {
    const configured = await isAutoSyncConfigured();
    expect(configured).toBe(true);
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

      vi.advanceTimersByTime(200);
      await Promise.resolve();
      expect(runSyncCalled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
