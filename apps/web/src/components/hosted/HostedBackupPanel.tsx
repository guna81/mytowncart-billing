// SPDX-License-Identifier: Apache-2.0
/** Settings → Cloud backup, shown instead of the desktop backup panels in the hosted web app (D13). */
import { useEffect, useState } from "react";

import { t } from "../../i18n";
import { loadConnection } from "../../lib/connection";
import {
  formattedLocalKey,
  keyMode,
  switchToManaged,
  switchToPrivate,
  type KeyMode,
} from "../../lib/hosted/backupKey";
import { backupNow, useCloudBackupStatus } from "../../lib/hosted/cloudBackup";
import { DESKTOP_DOWNLOAD_URL } from "../../lib/hosted/mode";
import { getHostedRepository, signOutAndWipe } from "../../lib/hosted/session";
import { LegalLinks } from "./LegalLinks";
import { RecoveryKeyConfirm } from "./RecoveryKeyConfirm";

const btnPrimary =
  "rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300";
const btnSecondary =
  "rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50";

export function HostedBackupPanel() {
  const status = useCloudBackupStatus();
  const [sellerName, setSellerName] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [mode, setMode] = useState<KeyMode | null>(null);
  const [choosingPrivate, setChoosingPrivate] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    void loadConnection().then((c) => setSellerName(c?.sellerName ?? ""));
    void keyMode().then(setMode);
  }, []);

  const becomePrivate = async (fresh: Uint8Array) => {
    await switchToPrivate(fresh);
    setMode("private");
    setChoosingPrivate(false);
    setKey(null);
    setMessage(t("hosted.mode_changed_private"));
    // Seal the shop with the new key straight away.
    const persisted = getHostedRepository();
    if (persisted) void backupNow(persisted);
  };

  const becomeManaged = async () => {
    setSwitching(true);
    setError(null);
    try {
      await switchToManaged();
      setMode("managed");
      setKey(null);
      setMessage(t("hosted.mode_changed_managed"));
    } catch (err) {
      setError(t("hosted.mode_change_failed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSwitching(false);
    }
  };

  const runBackup = async () => {
    const persisted = getHostedRepository();
    if (!persisted) return;
    setMessage(null);
    if (await backupNow(persisted)) setMessage(t("hosted.backup_done"));
  };

  const signOut = async () => {
    const prompt = mode === "private" ? t("hosted.sign_out_confirm") : t("hosted.sign_out_confirm_managed");
    if (!window.confirm(prompt)) return;
    setSigningOut(true);
    setError(null);
    if (!(await signOutAndWipe())) {
      setError(t("hosted.sign_out_backup_failed"));
      setSigningOut(false);
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-xs space-y-3" data-testid="hosted-backup-panel">
      <h2 className="font-semibold text-gray-800">{t("hosted.panel_title")}</h2>
      {sellerName ? <p className="text-sm text-gray-700">{t("hosted.panel_signed_in", { name: sellerName })}</p> : null}
      <p className="text-sm text-gray-600" data-testid="hosted-last-backup">
        {status.lastSuccessAt
          ? t("hosted.last_backup", { when: new Date(status.lastSuccessAt).toLocaleString() })
          : t("hosted.never_backed_up")}
      </p>
      {status.pending ? <p className="text-xs text-gray-500">{t("hosted.pending")}</p> : null}
      {status.lastError ? (
        <p className="text-sm text-red-700">{t("hosted.backup_failed", { message: status.lastError })}</p>
      ) : null}
      {message ? <p className="text-sm text-green-700">{message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnPrimary} disabled={status.running} onClick={() => void runBackup()} data-testid="hosted-backup-now">
          {status.running ? t("hosted.backing_up") : t("hosted.backup_now")}
        </button>
        {mode === "private" ? (
          <button type="button" className={btnSecondary} onClick={() => void formattedLocalKey().then(setKey)}>
            {t("hosted.show_key")}
          </button>
        ) : null}
        <button type="button" className={btnSecondary} disabled={signingOut} onClick={() => void signOut()} data-testid="hosted-sign-out">
          {t("hosted.sign_out")}
        </button>
      </div>
      {key ? <p className="rounded bg-amber-50 p-2 font-mono text-sm font-bold break-all">{key}</p> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {mode !== null ? (
        <div className="border-t border-gray-100 pt-3 space-y-2" data-testid="hosted-key-mode">
          <p className="text-sm text-gray-700">
            {mode === "managed" ? t("hosted.key_managed") : t("hosted.key_private")}
          </p>
          {mode === "managed" && !choosingPrivate ? (
            <button type="button" className={btnSecondary} onClick={() => setChoosingPrivate(true)} data-testid="hosted-use-private">
              {t("hosted.use_private")}
            </button>
          ) : null}
          {mode === "managed" && choosingPrivate ? (
            <RecoveryKeyConfirm
              title={t("hosted.private_title")}
              intro={t("hosted.private_intro")}
              onConfirmed={becomePrivate}
              onCancel={() => setChoosingPrivate(false)}
            />
          ) : null}
          {mode === "private" ? (
            <button type="button" className={btnSecondary} disabled={switching} onClick={() => void becomeManaged()} data-testid="hosted-use-managed">
              {t("hosted.use_managed")}
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="text-sm text-gray-600 border-t border-gray-100 pt-3">
        {t("hosted.download_hint")}{" "}
        <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-700 underline">
          {t("hosted.download_desktop")}
        </a>
      </p>
      <LegalLinks />
    </section>
  );
}
