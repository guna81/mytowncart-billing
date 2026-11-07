// SPDX-License-Identifier: Apache-2.0
/**
 * Filesystem side of B3 backups. The desktop shell owns all file I/O; these
 * helpers only build paths and call its narrow commands. In a plain browser
 * every call fails with `unsupported`, which the UI explains.
 */

export const BACKUP_FILE_EXT = ".mtcb";

/** `mytowncart-backup` in app settings: folder, last success, same-drive flag. */
export const BACKUP_SETTINGS_KEY = "backup.local";

export interface LocalBackupSettings {
  folder: string;
  lastSuccessAt: string | null;
  /** null when the platform could not tell (the UI then warns). */
  sameDrive: boolean | null;
}

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function backupFileName(createdAt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${createdAt.getFullYear()}-${pad(createdAt.getMonth() + 1)}-${pad(createdAt.getDate())}`;
  const time = `${pad(createdAt.getHours())}${pad(createdAt.getMinutes())}`;
  return `mytowncart-${date}-${time}${BACKUP_FILE_EXT}`;
}

/** Accepts `/` and `\` so a Windows folder chosen in the dialog still joins. */
export function joinPath(folder: string, file: string): string {
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  return folder.replace(/[\\/]+$/, "") + sep + file;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function parseBackupSettings(raw: string | null): LocalBackupSettings | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LocalBackupSettings>;
    if (typeof parsed.folder !== "string" || parsed.folder === "") return null;
    return {
      folder: parsed.folder,
      lastSuccessAt: typeof parsed.lastSuccessAt === "string" ? parsed.lastSuccessAt : null,
      sameDrive: typeof parsed.sameDrive === "boolean" ? parsed.sameDrive : null,
    };
  } catch {
    return null;
  }
}

export async function writeBackupFile(
  invoke: Invoke,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await invoke("write_backup_file", { path, bytes: Array.from(bytes) });
}

export async function readBackupFile(invoke: Invoke, path: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<number[]>("read_backup_file", { path }));
}

/** Modification time as epoch seconds, or null when the file is missing. */
export async function backupFileModifiedSecs(invoke: Invoke, path: string): Promise<number | null> {
  return invoke<number | null>("backup_file_info", { path });
}

export async function sameVolume(invoke: Invoke, path: string): Promise<boolean | null> {
  return invoke<boolean | null>("same_volume", { path });
}

export async function snapshotDatabase(invoke: Invoke): Promise<Uint8Array> {
  return new Uint8Array(await invoke<number[]>("db_snapshot"));
}

/** Swaps the plaintext database in; returns the pre-restore copy path. */
export async function restoreDatabase(invoke: Invoke, gz: Uint8Array): Promise<string> {
  return invoke<string>("restore_snapshot", { gz: Array.from(gz) });
}

// --- Master backup (bundle v2): raw binary IPC, no JSON number arrays. ---

export type InvokeRaw = <T>(
  command: string,
  args?: Uint8Array | Record<string, unknown>,
  options?: { headers?: Record<string, string> },
) => Promise<T>;

/** Database snapshot plus all photos, as one plaintext bundle. */
export async function snapshotBundle(invokeRaw: InvokeRaw): Promise<Uint8Array> {
  return new Uint8Array(await invokeRaw<ArrayBuffer>("bundle_snapshot"));
}

export async function writeBackupRaw(
  invokeRaw: InvokeRaw,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await invokeRaw("write_backup_raw", bytes, { headers: { "x-path": encodeURIComponent(path) } });
}

export async function readBackupRaw(invokeRaw: InvokeRaw, path: string): Promise<Uint8Array> {
  return new Uint8Array(await invokeRaw<ArrayBuffer>("read_backup_raw", { path }));
}

/** Restores a decrypted bundle (or legacy gzip'd DB); returns the pre-restore copy path. */
export async function restoreBackup(invokeRaw: InvokeRaw, plain: Uint8Array): Promise<string> {
  return invokeRaw<string>("restore_backup", plain);
}
