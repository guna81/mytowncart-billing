// SPDX-License-Identifier: Apache-2.0
/**
 * `@mytowncart-billing/backup` — snapshot, compress, AES-256-GCM
 * (WebCrypto), and `BackupProvider`s (roadmap §8.7).
 *
 * B0 ships the provider contract only. B3 adds the encrypted snapshot
 * pipeline and the `LocalFolderBackupProvider` — the only provider shipped
 * in v1 (the MyTownCart cloud provider is GATED by O4/D12).
 *
 * Backups are ALWAYS client-side encrypted (D5); the recovery key lives in
 * the OS keychain via the desktop shell, never in SQLite, never in a backup.
 */

export * from "./crypto";
export * from "./files";

export interface BackupMeta {
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  /** e.g. `{ cipher: "aes-256-gcm", kdf: "hkdf-sha-256", saltB64: string }` */
  cryptoParams: Record<string, string>;
}

export interface BackupInfo {
  id: string;
  createdAt: string;
  sizeBytes: number;
}

export interface BackupProvider {
  id: string;
  label: string;
  upload(blob: Uint8Array, meta: BackupMeta): Promise<void>;
  list(): Promise<BackupInfo[]>;
  download(id: string): Promise<{ blob: Uint8Array; meta: BackupMeta }>;
  remove(id: string): Promise<void>;
}
