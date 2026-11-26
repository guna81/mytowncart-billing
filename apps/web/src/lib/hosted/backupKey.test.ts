// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatRecoveryKey, parseRecoveryKey } from "@mytowncart-billing/backup";
import { MarketplaceError, type BackupKeySetting } from "@mytowncart-billing/connector-mytowncart";

const store = new Map<string, unknown>();
let localText: string | null = null;
const connector = {
  getBackupKey: vi.fn<() => Promise<BackupKeySetting | null>>(),
  putBackupKey: vi.fn<(s: BackupKeySetting, o?: { replace?: boolean }) => Promise<void>>(),
};

vi.mock("./idb", () => ({
  idbGet: async (k: string) => store.get(k),
  idbSet: async (k: string, v: unknown) => void store.set(k, v),
}));
vi.mock("./keystore", () => ({ hostedInvoke: vi.fn() }));
vi.mock("../cryptoStore", () => ({
  revealRecoveryKey: async () => localText,
  saveRecoveryKey: async (_invoke: unknown, raw: Uint8Array) => {
    localText = formatRecoveryKey(raw);
  },
}));
vi.mock("../marketplace", () => ({ getConnector: () => connector }));

const { ensureBackupKey, keyForBackup, keyMode, switchToManaged, switchToPrivate } = await import("./backupKey");

const key = (fill: number) => new Uint8Array(20).fill(fill);
const local = () => (localText === null ? null : parseRecoveryKey(localText));

beforeEach(() => {
  store.clear();
  localText = null;
  connector.getBackupKey.mockReset();
  connector.putBackupKey.mockReset();
});

describe("ensureBackupKey", () => {
  it("adopts the key MyTownCart keeps for this shop", async () => {
    connector.getBackupKey.mockResolvedValue({ mode: "managed", key: key(7) });
    expect(await ensureBackupKey()).toBe("ready");
    expect(local()).toEqual(key(7));
    expect(connector.putBackupKey).not.toHaveBeenCalled();
  });

  it("creates a key and hands it to the server for a new shop", async () => {
    connector.getBackupKey.mockResolvedValue(null);
    connector.putBackupKey.mockResolvedValue();
    expect(await ensureBackupKey()).toBe("ready");
    expect(local()).not.toBeNull();
    expect(connector.putBackupKey).toHaveBeenCalledWith({ mode: "managed", key: local() });
    expect(store.get("backupKey.escrowed")).toBe(true);
  });

  it("asks for a new private key when the shop keeps its own", async () => {
    connector.getBackupKey.mockResolvedValue({ mode: "private" });
    expect(await ensureBackupKey()).toBe("private_setup");
    expect(local()).toBeNull();
  });

  it("never blocks billing when the server cannot be reached", async () => {
    connector.getBackupKey.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await ensureBackupKey()).toBe("ready");
    expect(local()).not.toBeNull();
    expect(store.get("backupKey.escrowed")).toBe(false);
  });

  it("surfaces sign-in problems", async () => {
    connector.getBackupKey.mockRejectedValue(new MarketplaceError("unauthorized", "x", 401));
    await expect(ensureBackupKey()).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("keeps an existing local key without asking the server", async () => {
    localText = formatRecoveryKey(key(3));
    expect(await ensureBackupKey()).toBe("ready");
    expect(connector.getBackupKey).not.toHaveBeenCalled();
  });
});

describe("keyForBackup", () => {
  it("hands an unescrowed key to the server before the backup", async () => {
    localText = formatRecoveryKey(key(1));
    connector.putBackupKey.mockResolvedValue();
    expect(await keyForBackup()).toEqual(key(1));
    expect(connector.putBackupKey).toHaveBeenCalledOnce();
    await keyForBackup();
    expect(connector.putBackupKey).toHaveBeenCalledOnce();
  });

  it("switches to the server's key when another device set one up first", async () => {
    localText = formatRecoveryKey(key(1));
    connector.putBackupKey.mockRejectedValue(new MarketplaceError("key_exists", "x", 409));
    connector.getBackupKey.mockResolvedValue({ mode: "managed", key: key(9) });
    expect(await keyForBackup()).toEqual(key(9));
    expect(local()).toEqual(key(9));
  });

  it("respects a private choice made on another device", async () => {
    localText = formatRecoveryKey(key(1));
    connector.putBackupKey.mockRejectedValue(new MarketplaceError("key_exists", "x", 409));
    connector.getBackupKey.mockResolvedValue({ mode: "private" });
    expect(await keyForBackup()).toEqual(key(1));
    expect(await keyMode()).toBe("private");
  });

  it("still backs up when key storage is unavailable, and retries next time", async () => {
    localText = formatRecoveryKey(key(1));
    connector.putBackupKey.mockRejectedValue(new MarketplaceError("key_escrow_unavailable", "x", 503));
    expect(await keyForBackup()).toEqual(key(1));
    connector.putBackupKey.mockResolvedValue();
    await keyForBackup();
    expect(connector.putBackupKey).toHaveBeenCalledTimes(2);
  });

  it("never sends the key in private mode", async () => {
    localText = formatRecoveryKey(key(1));
    store.set("backupKey.mode", "private");
    expect(await keyForBackup()).toEqual(key(1));
    expect(connector.putBackupKey).not.toHaveBeenCalled();
  });
});

describe("switching modes", () => {
  it("private: wipes the server copy, then uses a key the server never saw", async () => {
    localText = formatRecoveryKey(key(1));
    connector.putBackupKey.mockResolvedValue();
    await switchToPrivate(key(5));
    expect(connector.putBackupKey).toHaveBeenCalledWith({ mode: "private" }, { replace: true });
    expect(local()).toEqual(key(5));
    expect(await keyMode()).toBe("private");
  });

  it("private: changes nothing locally if the server call fails", async () => {
    localText = formatRecoveryKey(key(1));
    connector.putBackupKey.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(switchToPrivate(key(5))).rejects.toThrow();
    expect(local()).toEqual(key(1));
    expect(await keyMode()).toBe("managed");
  });

  it("managed: hands this browser's key back to the server", async () => {
    localText = formatRecoveryKey(key(5));
    store.set("backupKey.mode", "private");
    connector.putBackupKey.mockResolvedValue();
    await switchToManaged();
    expect(connector.putBackupKey).toHaveBeenCalledWith({ mode: "managed", key: key(5) }, { replace: true });
    expect(await keyMode()).toBe("managed");
  });
});
