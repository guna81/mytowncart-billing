// SPDX-License-Identifier: Apache-2.0
/**
 * Restore from a master backup: pick the file, type its recovery key, review
 * what is inside, then confirm. Used in Settings and on a brand-new install
 * (before the shop is even set up), which is the dead-PC recovery case.
 */
import { useState } from "react";

import { restoreBackup } from "@mytowncart-billing/backup";

import { t } from "../i18n";
import {
  hasRecoveryKey,
  openBackupFile,
  saveRecoveryKey,
  type BackupOpenResult,
} from "../lib/cryptoStore";
import { invoke, invokeRaw, pickPath } from "../lib/shell";
import { isInTauri } from "../lib/tauri";

/** Newest database schema this app can open. */
export const SUPPORTED_BACKUP_SCHEMA = 5;

const inputCls = "mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono";
const labelCls = "block text-sm font-medium text-gray-700";

type Opened = Extract<BackupOpenResult, { ok: true }>;

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function RestoreFlow() {
  const [path, setPath] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [result, setResult] = useState<{ kept: string; keySaved: boolean } | null>(null);

  if (!isInTauri()) return <p className="text-gray-500">{t("backup.unsupported")}</p>;

  const reset = () => {
    setOpened(null);
    setError(null);
  };

  const browse = async () => {
    const chosen = await pickPath({ directory: false, title: t("backup.restore_path") });
    if (chosen) {
      setPath(chosen);
      reset();
    }
  };

  const check = async () => {
    reset();
    setBusy(true);
    try {
      const out = await openBackupFile(invokeRaw, path.trim(), key);
      if (!out.ok) {
        setError(
          out.error === "wrong_key" || out.error === "bad_key"
            ? t("backup.restore_wrong_key")
            : out.error === "not_backup"
              ? t("backup.restore_not_backup")
              : t("backup.restore_corrupt"),
        );
        return;
      }
      if (out.schemaVersion > SUPPORTED_BACKUP_SCHEMA) {
        setError(t("backup.restore_newer"));
        return;
      }
      setOpened(out);
    } catch (err) {
      setError(t("backup.restore_failed", { message: errorText(err) }));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (opened === null) return;
    if (!window.confirm(t("backup.restore_confirm"))) return;
    setError(null);
    setBusy(true);
    try {
      const kept = await restoreBackup(invokeRaw, opened.plain);
      // A new PC has no key in its keychain yet; keep the one just proven good
      // so the next automatic backup works without extra steps.
      let keySaved = false;
      if (!(await hasRecoveryKey(invoke))) {
        await saveRecoveryKey(invoke, opened.key);
        keySaved = true;
      }
      setResult({ kept, keySaved });
      setOpened(null);
    } catch (err) {
      setError(t("backup.restore_failed", { message: errorText(err) }));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="rounded bg-green-50 p-3 text-green-800" data-testid="backup-restore-done">
        <p>{t("backup.restore_done", { path: result.kept })}</p>
        {result.keySaved ? <p className="mt-1">{t("backup.restore_key_saved")}</p> : null}
      </div>
    );
  }

  const summary = opened?.summary;
  return (
    <div data-testid="backup-restore">
      <p className="text-gray-500">{t("backup.restore_intro")}</p>
      <label className={`${labelCls} mt-2`}>
        {t("backup.restore_path")}
        <div className="flex gap-2">
          <input
            className={inputCls}
            data-testid="backup-restore-path"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              reset();
            }}
          />
          <button
            type="button"
            className="mt-1 shrink-0 rounded border border-gray-300 bg-white px-3 py-2 text-sm"
            data-testid="backup-restore-browse"
            onClick={() => void browse()}
          >
            {t("backup.browse")}
          </button>
        </div>
      </label>
      <label className={`${labelCls} mt-2`}>
        {t("backup.restore_key")}
        <input
          className={inputCls}
          data-testid="backup-restore-key"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            reset();
          }}
        />
      </label>

      {error ? (
        <p className="mt-2 text-red-600" data-testid="backup-restore-error">
          {error}
        </p>
      ) : null}

      {opened && summary ? (
        <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3" data-testid="backup-restore-review">
          <p className="font-medium text-blue-900">{t("backup.review_title")}</p>
          <ul className="mt-1 list-disc pl-5 text-blue-900">
            <li>{t("backup.review_date", { when: new Date(opened.createdAt).toLocaleString() })}</li>
            {summary.itemCount !== null ? (
              <li>{t("backup.review_items", { count: summary.itemCount })}</li>
            ) : null}
            {summary.photoCount !== null && summary.photoBytes !== null ? (
              <li>
                {t("backup.review_photos", {
                  count: summary.photoCount,
                  mb: megabytes(summary.photoBytes),
                })}
              </li>
            ) : (
              <li className="text-amber-800">{t("backup.review_no_photos")}</li>
            )}
          </ul>
        </div>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm"
          data-testid="backup-restore-check"
          disabled={busy || path.trim() === "" || key.trim() === ""}
          onClick={() => void check()}
        >
          {busy && !opened ? t("backup.checking") : t("backup.check")}
        </button>
        <button
          type="button"
          className="rounded border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 disabled:opacity-40"
          data-testid="backup-restore-start"
          disabled={busy || opened === null}
          onClick={() => void restore()}
        >
          {t("backup.restore_start")}
        </button>
      </div>
    </div>
  );
}
