// SPDX-License-Identifier: Apache-2.0
/**
 * Backup and restore (B3, roadmap §8.7). The seller creates a recovery key
 * once, picks a folder (ideally a USB drive — a same-disk folder is called
 * out), and backs up with one button. Restoring always keeps the current
 * database as a pre-restore copy and asks for a restart.
 */
import { useCallback, useEffect, useState } from "react";

import { APP_VERSION } from "@mytowncart-billing/core";
import {
  backupFileName,
  BACKUP_SETTINGS_KEY,
  defaultBackupDir,
  folderExists,
  joinPath,
  openFolder,
  parseBackupSettings,
  sameVolume,
  writeBackupRaw,
  type LocalBackupSettings,
} from "@mytowncart-billing/backup";

import { t } from "../i18n";
import {
  createRecoveryKey,
  encryptMasterBackup,
  hasRecoveryKey,
  revealRecoveryKey,
  verifyWrittenBackup,
} from "../lib/cryptoStore";
import { invoke, invokeRaw, pickPath } from "../lib/shell";
import { RestoreFlow } from "./RestoreFlow";
import { getRepository } from "../lib/repository";
import { isInTauri } from "../lib/tauri";

const inputCls = "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 shadow-2xs";
const labelCls = "block text-sm font-medium text-gray-700";
const btnPrimary =
  "rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300";

const BACKUP_SCHEMA_VERSION = 5;

function daysSince(iso: string): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.floor((Date.now() - then) / 86_400_000);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function BackupPanel() {
  const supported = isInTauri();
  const [keyState, setKeyState] = useState<"loading" | "none" | "ready">("loading");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [settings, setSettings] = useState<LocalBackupSettings | null>(null);
  const [folder, setFolder] = useState("");
  const [defaultPath, setDefaultPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshKey = useCallback(async () => {
    if (!supported) return;
    setKeyState((await hasRecoveryKey(invoke)) ? "ready" : "none");
  }, [supported]);

  const refreshSettings = useCallback(async () => {
    if (!supported) return;
    const repo = getRepository();
    const loaded = parseBackupSettings(await repo.getAppSetting(BACKUP_SETTINGS_KEY));
    let def = "";
    try {
      def = await defaultBackupDir(invoke);
      setDefaultPath(def);
    } catch {
      // non-fatal if default directory cannot be resolved
    }

    if (loaded && loaded.folder.trim()) {
      const exists = await folderExists(invoke, loaded.folder.trim());
      if (exists) {
        setSettings(loaded);
        setFolder(loaded.folder.trim());
        return;
      }
    }

    // If no setting, or the previously configured folder no longer exists on disk:
    if (def) {
      setFolder(def);
      const onSameDrive = await sameVolume(invoke, def);
      const initial: LocalBackupSettings = {
        folder: def,
        lastSuccessAt: loaded?.lastSuccessAt ?? null,
        sameDrive: onSameDrive,
      };
      await repo.setAppSetting(BACKUP_SETTINGS_KEY, JSON.stringify(initial));
      setSettings(initial);
    }
  }, [supported]);

  useEffect(() => {
    void refreshKey();
    void refreshSettings();
  }, [refreshKey, refreshSettings]);

  const createKey = async () => {
    setError(null);
    setFreshKey(await createRecoveryKey(invoke));
    setKeyState("ready");
  };

  const copyKey = async () => {
    if (revealedKey === null) return;
    await navigator.clipboard.writeText(revealedKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const saveFolder = async (folderToSave?: string) => {
    setError(null);
    const target = (folderToSave ?? folder).trim();
    if (target === "") return false;
    const exists = await folderExists(invoke, target);
    if (!exists) return false;
    const onSameDrive = await sameVolume(invoke, target);
    const next: LocalBackupSettings = {
      folder: target,
      lastSuccessAt: settings?.lastSuccessAt ?? null,
      sameDrive: onSameDrive,
    };
    await getRepository().setAppSetting(BACKUP_SETTINGS_KEY, JSON.stringify(next));
    setSettings(next);
    setFolder(target);
    return true;
  };

  const onFolderChange = (val: string) => {
    setFolder(val);
    const trimmed = val.trim();
    if (trimmed) {
      void folderExists(invoke, trimmed).then((exists) => {
        if (exists) {
          void saveFolder(trimmed);
        }
      });
    }
  };

  const onFolderBlur = async () => {
    const trimmed = folder.trim();
    if (!trimmed && defaultPath) {
      setFolder(defaultPath);
      await saveFolder(defaultPath);
      return;
    }
    if (trimmed) {
      const exists = await folderExists(invoke, trimmed);
      if (exists) {
        await saveFolder(trimmed);
      }
    }
  };

  const browseFolder = async () => {
    setError(null);
    const chosen = await pickPath({
      directory: true,
      title: t("backup.folder"),
      defaultPath: folder.trim() || defaultPath || undefined,
    });
    if (chosen) {
      setFolder(chosen);
      await saveFolder(chosen);
    }
  };

  const handleOpenFolder = async () => {
    const target = (folder || settings?.folder || defaultPath || "").trim();
    if (!target) return;
    try {
      await openFolder(invoke, target);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const handleUseDefault = async () => {
    if (defaultPath) {
      setFolder(defaultPath);
      await saveFolder(defaultPath);
    }
  };

  const backupNow = async () => {
    setError(null);
    setMessage(null);
    const targetFolder = (folder || settings?.folder || defaultPath || "").trim();
    if (!targetFolder) return;
    setBusy(true);
    try {
      const createdAt = new Date();
      const bytes = await encryptMasterBackup(invoke, invokeRaw, {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        appVersion: APP_VERSION,
        createdAt: createdAt.toISOString(),
      });
      const file = backupFileName(createdAt);
      const target = joinPath(targetFolder, file);
      await writeBackupRaw(invokeRaw, target, bytes);
      // Read it straight back and decrypt it, so a "saved" backup is known good.
      const check = await verifyWrittenBackup(invoke, invokeRaw, target);
      if (!check.ok) throw new Error(t("backup.verify_failed"));
      const next: LocalBackupSettings = {
        folder: targetFolder,
        lastSuccessAt: createdAt.toISOString(),
        sameDrive: await sameVolume(invoke, targetFolder),
      };
      await getRepository().setAppSetting(BACKUP_SETTINGS_KEY, JSON.stringify(next));
      setSettings(next);
      setFolder(targetFolder);
      setMessage(
        check.summary.photoCount !== null
          ? t("backup.save_done_full", {
              file,
              items: check.summary.itemCount ?? 0,
              photos: check.summary.photoCount,
            })
          : t("backup.save_done", { file }),
      );
    } catch (err) {
      const message = errorText(err);
      setError(
        message === "no_recovery_key"
          ? t("backup.key_required")
          : t("backup.save_failed", { message }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded border border-gray-200 bg-white p-4 text-sm text-gray-700" data-testid="backup-panel">
      <h2 className="font-semibold mb-2 text-gray-800">{t("backup.title")}</h2>
      {!supported ? <p className="text-gray-500">{t("backup.unsupported")}</p> : null}
      {supported ? (
        <>
          <p>{t("backup.intro")}</p>

          <div className="mt-4 border-t border-gray-100 pt-3">
            <h3 className="font-medium text-gray-800">{t("backup.key")}</h3>
            {keyState === "loading" ? <p>{t("common.loading")}</p> : null}
            {keyState === "none" ? (
              <button
                type="button"
                className={`${btnPrimary} mt-2`}
                data-testid="backup-create-key"
                onClick={() => void createKey()}
              >
                {t("backup.key_create")}
              </button>
            ) : null}
            {keyState === "ready" ? (
              <p className="mt-1 text-green-700" data-testid="backup-key-ready">
                {t("backup.key_ready")}
              </p>
            ) : null}
            {freshKey ? (
              <div className="mt-2 rounded bg-amber-50 p-3" data-testid="backup-key-panel">
                <p className="text-amber-900">{t("backup.key_show_once")}</p>
                <p className="my-2 break-all font-mono text-lg font-bold tracking-wider" data-testid="backup-key">
                  {freshKey}
                </p>
                <button
                  type="button"
                  className="rounded border border-amber-300 bg-white px-3 py-1.5 text-sm"
                  data-testid="backup-key-ack"
                  onClick={() => setFreshKey(null)}
                >
                  {t("backup.key_saved")}
                </button>
              </div>
            ) : null}
            {keyState === "ready" && !freshKey ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm"
                  data-testid="backup-key-reveal"
                  onClick={() => void revealRecoveryKey(invoke).then(setRevealedKey)}
                >
                  {t("backup.key_reveal")}
                </button>
                {revealedKey ? (
                  <>
                    <code className="break-all rounded bg-gray-100 px-2 py-1" data-testid="backup-key-value">
                      {revealedKey}
                    </code>
                    <button
                      type="button"
                      className="text-sm text-blue-700 underline"
                      onClick={() => void copyKey()}
                    >
                      {copied ? t("backup.key_copied") : t("backup.key_copy")}
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="mt-4 border-t border-gray-100 pt-3">
            <label className={labelCls}>
              {t("backup.folder")}
              <input
                className={inputCls}
                data-testid="backup-folder"
                placeholder={defaultPath || t("backup.folder_ph")}
                value={folder}
                onChange={(e) => onFolderChange(e.target.value)}
                onBlur={() => void onFolderBlur()}
              />
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer"
                data-testid="backup-folder-browse"
                onClick={() => void browseFolder()}
              >
                {t("backup.browse")}
              </button>
              {defaultPath && folder.trim() !== defaultPath.trim() ? (
                <button
                  type="button"
                  className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900 cursor-pointer"
                  data-testid="backup-folder-default"
                  onClick={() => void handleUseDefault()}
                >
                  {t("backup.default_path")}
                </button>
              ) : null}
              <button
                type="button"
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="backup-folder-open"
                disabled={!folder.trim()}
                onClick={() => void handleOpenFolder()}
              >
                {t("backup.open_folder")}
              </button>
              <button
                type="button"
                className={btnPrimary}
                data-testid="backup-now"
                disabled={busy || !folder.trim() || keyState !== "ready"}
                onClick={() => void backupNow()}
              >
                {busy ? t("backup.saving") : t("backup.saved_now")}
              </button>
            </div>
            {settings?.sameDrive ? (
              <p className="mt-2 text-amber-800" data-testid="backup-same-drive">
                {t("backup.same_drive")}
              </p>
            ) : null}
            <p className="mt-2 text-gray-500" data-testid="backup-last">
              {settings?.lastSuccessAt
                ? t("backup.last", { when: new Date(settings.lastSuccessAt).toLocaleString() })
                : t("backup.never")}
            </p>
            {settings?.lastSuccessAt && daysSince(settings.lastSuccessAt) >= 7 ? (
              <p className="text-amber-800" data-testid="backup-due">
                {t("backup.due", { days: daysSince(settings.lastSuccessAt) })}
              </p>
            ) : null}
            {message ? (
              <p className="mt-2 text-green-700" data-testid="backup-message">{message}</p>
            ) : null}
            {error ? (
              <p className="mt-2 text-red-600" data-testid="backup-error">{error}</p>
            ) : null}
          </div>

          <div className="mt-4 border-t border-gray-100 pt-3">
            <h3 className="font-medium text-gray-800">{t("backup.restore")}</h3>
            <RestoreFlow />
          </div>
        </>
      ) : null}
    </section>
  );
}
