// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  BACKUP_MAGIC,
  decryptSnapshot,
  encryptSnapshot,
  formatRecoveryKey,
  generateRecoveryKey,
  isBackupFile,
  parseRecoveryKey,
  RECOVERY_KEY_GROUPS,
} from "../src/crypto";
import {
  backupFileName,
  defaultBackupDir,
  folderExists,
  joinPath,
  openFolder,
  parseBackupSettings,
  type Invoke,
} from "../src/files";

const meta = { schemaVersion: 5, appVersion: "0.1.0", createdAt: "2026-11-05T10:00:00.000Z" };
const payload = new TextEncoder().encode("SQLite format 3\0pretend database bytes");

describe("recovery keys", () => {
  it("formats 8 groups of 4 and round-trips through parsing", () => {
    const { raw, text } = generateRecoveryKey();
    expect(raw).toHaveLength(20);
    expect(text.split(" ")).toHaveLength(RECOVERY_KEY_GROUPS);
    expect(parseRecoveryKey(text)).toEqual(raw);
  });

  it("tolerates how people type it back", () => {
    const { raw, text } = generateRecoveryKey();
    expect(parseRecoveryKey(text.toLowerCase().replaceAll(" ", "-"))).toEqual(raw);
    expect(parseRecoveryKey(`  ${text.replaceAll(" ", "")}  `)).toEqual(raw);
  });

  it("rejects short, overlong and non-base32 keys", () => {
    expect(parseRecoveryKey("")).toBeNull();
    expect(parseRecoveryKey("AAAA AAAA")).toBeNull();
    const { text } = generateRecoveryKey();
    expect(parseRecoveryKey(`${text} AAA`)).toBeNull();
    expect(parseRecoveryKey(`${text.slice(1)}1`)).toBeNull();
  });

  it("is stable for a fixed key", () => {
    // 20 zero bytes = 32 base32 characters in groups of 4.
    expect(formatRecoveryKey(new Uint8Array(20))).toBe("AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA");
  });
});

describe("encrypted envelope", () => {
  it("round-trips the snapshot and carries the metadata", async () => {
    const { raw } = generateRecoveryKey();
    const file = await encryptSnapshot(payload, raw, meta);
    expect(new TextDecoder().decode(file.subarray(0, 5))).toBe(BACKUP_MAGIC);
    expect(isBackupFile(file)).toBe(true);

    const out = await decryptSnapshot(file, raw);
    expect(out.plaintext).toEqual(payload);
    expect(out.header).toMatchObject({
      v: 1,
      schema_version: 5,
      app_version: "0.1.0",
      created_at: meta.createdAt,
      cipher: "aes-256-gcm",
    });
  });

  it("uses a fresh salt and nonce every time", async () => {
    const { raw } = generateRecoveryKey();
    const a = await encryptSnapshot(payload, raw, meta);
    const b = await encryptSnapshot(payload, raw, meta);
    expect(a).not.toEqual(b);
  });

  it("refuses the wrong recovery key", async () => {
    const { raw } = generateRecoveryKey();
    const other = generateRecoveryKey().raw;
    const file = await encryptSnapshot(payload, raw, meta);
    await expect(decryptSnapshot(file, other)).rejects.toThrow("wrong_key");
  });

  it("detects a tampered header (it is the AAD)", async () => {
    const { raw } = generateRecoveryKey();
    const file = await encryptSnapshot(payload, raw, meta);
    // Change the ciphertext bytes (after the header) — GCM must reject them.
    const tampered = file.slice();
    tampered[tampered.length - 20] ^= 0x01;
    await expect(decryptSnapshot(tampered, raw)).rejects.toThrow("wrong_key");

    // Changing the header keeps JSON valid (same length) but breaks the AAD.
    const headerText = new TextDecoder().decode(file.subarray(9, 9 + 200));
    const forged = new TextEncoder().encode(headerText.replace("0.1.0", "0.9.9"));
    const forgedFile = file.slice();
    forgedFile.set(forged, 9);
    await expect(decryptSnapshot(forgedFile, raw)).rejects.toThrow("wrong_key");
  });

  it("rejects files that are not backups", async () => {
    const { raw } = generateRecoveryKey();
    await expect(decryptSnapshot(payload, raw)).rejects.toThrow("not_found");
    const truncated = new Uint8Array([
      ...new TextEncoder().encode(BACKUP_MAGIC), 0, 0, 0, 99, ...new Uint8Array(32).fill(1),
    ]);
    await expect(decryptSnapshot(truncated, raw)).rejects.toThrow("corrupt");
  });
});

describe("file helpers", () => {
  it("names backups by date and time", () => {
    expect(backupFileName(new Date(2026, 10, 5, 9, 7))).toBe("mytowncart-2026-11-05-0907.mtcb");
  });

  it("joins folders for both separator styles", () => {
    expect(joinPath("/Volumes/USB/", "a.mtcb")).toBe("/Volumes/USB/a.mtcb");
    expect(joinPath("D:\\Backups", "a.mtcb")).toBe("D:\\Backups\\a.mtcb");
  });

  it("ignores malformed settings", () => {
    expect(parseBackupSettings(null)).toBeNull();
    expect(parseBackupSettings("not json")).toBeNull();
    expect(parseBackupSettings('{"folder":""}')).toBeNull();
    expect(parseBackupSettings('{"folder":"/b","lastSuccessAt":"2026-11-05T10:00:00.000Z"}')).toEqual({
      folder: "/b",
      lastSuccessAt: "2026-11-05T10:00:00.000Z",
      sameDrive: null,
    });
  });

  it("invokes default_backup_dir command", async () => {
    const mockInvoke: Invoke = async <T>(cmd: string): Promise<T> => {
      if (cmd === "default_backup_dir") return "/Users/test/Documents/MyTownCart Backups" as T;
      throw new Error(`unexpected command ${cmd}`);
    };
    const dir = await defaultBackupDir(mockInvoke);
    expect(dir).toBe("/Users/test/Documents/MyTownCart Backups");
  });

  it("invokes open_folder command", async () => {
    let invokedCmd: string | null = null;
    let invokedArgs: Record<string, unknown> | undefined;
    const mockInvoke: Invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      invokedCmd = cmd;
      invokedArgs = args;
      return undefined as T;
    };
    await openFolder(mockInvoke, "/Users/test/Documents/MyTownCart Backups");
    expect(invokedCmd).toBe("open_folder");
    expect(invokedArgs).toEqual({ path: "/Users/test/Documents/MyTownCart Backups" });
  });

  it("invokes folder_exists command", async () => {
    let checkedPath: string | null = null;
    const mockInvoke: Invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      if (cmd === "folder_exists") {
        checkedPath = args?.path as string;
        return (checkedPath === "/existing/folder") as T;
      }
      throw new Error(`unexpected command ${cmd}`);
    };
    expect(await folderExists(mockInvoke, "/existing/folder")).toBe(true);
    expect(checkedPath).toBe("/existing/folder");
    expect(await folderExists(mockInvoke, "/nonexistent/folder")).toBe(false);
  });
});
