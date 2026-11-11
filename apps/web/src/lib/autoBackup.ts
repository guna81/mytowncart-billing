// SPDX-License-Identifier: Apache-2.0
import { APP_VERSION } from "@mytowncart-billing/core";
import {
  backupFileName,
  BACKUP_SETTINGS_KEY,
  defaultBackupDir,
  joinPath,
  parseBackupSettings,
  sameVolume,
  writeBackupRaw,
} from "@mytowncart-billing/backup";
import { encryptMasterBackup, hasRecoveryKey, verifyWrittenBackup } from "./cryptoStore";
import { invoke, invokeRaw } from "./shell";
import { getRepository } from "./repository";
import { isInTauri } from "./tauri";

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
    let folder = settings?.folder?.trim();
    if (!folder) {
      try {
        folder = await defaultBackupDir(invoke);
      } catch {
        return false;
      }
    }
    if (!folder) return false;

    // Check if > 24 hours since last backup
    if (settings?.lastSuccessAt) {
      const msSince = Date.now() - Date.parse(settings.lastSuccessAt);
      if (msSince < 86_400_000) {
        return false; // Up to date
      }
    }

    const hasKey = await hasRecoveryKey(invoke);
    if (!hasKey) return false;

    const createdAt = new Date();
    const bytes = await encryptMasterBackup(invoke, invokeRaw, {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      appVersion: APP_VERSION,
      createdAt: createdAt.toISOString(),
    });

    const file = backupFileName(createdAt);
    const target = joinPath(folder, file);
    await writeBackupRaw(invokeRaw, target, bytes);
    const check = await verifyWrittenBackup(invoke, invokeRaw, target);
    if (!check.ok) {
      console.warn(`[auto-backup] Backup written but could not be verified (${check.error})`);
      return false;
    }

    const next = {
      folder,
      lastSuccessAt: createdAt.toISOString(),
      sameDrive: await sameVolume(invoke, folder),
    };
    await repo.setAppSetting(BACKUP_SETTINGS_KEY, JSON.stringify(next));
    console.info(`[auto-backup] Automated daily backup saved: ${file}`);
    return true;
  } catch (err) {
    console.warn("[auto-backup] Automated backup skipped or failed:", err);
    return false;
  }
}
