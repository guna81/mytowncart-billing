// SPDX-License-Identifier: Apache-2.0
import { APP_VERSION } from "@mytowncart-billing/core";
import {
  backupFileName,
  BACKUP_SETTINGS_KEY,
  joinPath,
  parseBackupSettings,
  sameVolume,
  writeBackupFile,
  type Invoke,
} from "@mytowncart-billing/backup";
import {
  encryptCurrentDatabase,
  hasRecoveryKey,
} from "./cryptoStore";
import { getRepository } from "./repository";
import { isInTauri } from "./tauri";

async function shellInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args) as Promise<T>;
}

const invoke: Invoke = (command, args) => shellInvoke(command, args);

const BACKUP_SCHEMA_VERSION = 5;

/**
 * Check if automated daily backup is due (> 24 hours since last backup)
 * and perform automated local backup if configured.
 */
export async function checkAndRunAutoBackup(): Promise<boolean> {
  if (!isInTauri()) return false;

  try {
    const repo = getRepository();
    const raw = await repo.getAppSetting(BACKUP_SETTINGS_KEY);
    const settings = parseBackupSettings(raw);
    if (!settings || !settings.folder.trim()) return false;

    // Check if > 24 hours since last backup
    if (settings.lastSuccessAt) {
      const msSince = Date.now() - Date.parse(settings.lastSuccessAt);
      if (msSince < 86_400_000) {
        return false; // Up to date
      }
    }

    const hasKey = await hasRecoveryKey(invoke);
    if (!hasKey) return false;

    const createdAt = new Date();
    const bytes = await encryptCurrentDatabase(invoke, {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      appVersion: APP_VERSION,
      createdAt: createdAt.toISOString(),
    });

    const file = backupFileName(createdAt);
    await writeBackupFile(invoke, joinPath(settings.folder, file), bytes);

    const next = {
      ...settings,
      lastSuccessAt: createdAt.toISOString(),
      sameDrive: await sameVolume(invoke, settings.folder),
    };
    await repo.setAppSetting(BACKUP_SETTINGS_KEY, JSON.stringify(next));
    console.info(`[auto-backup] Automated daily backup saved: ${file}`);
    return true;
  } catch (err) {
    console.warn("[auto-backup] Automated backup skipped or failed:", err);
    return false;
  }
}
