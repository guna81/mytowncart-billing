// SPDX-License-Identifier: Apache-2.0
/**
 * Startup gate for the hosted web app (D13). Before the billing UI renders:
 * MyTownCart sign-in (mandatory) → when this browser is empty and the shop
 * has backups, restore the latest automatically with the key MyTownCart keeps
 * (or ask for the recovery key in private mode) → make sure a backup key
 * exists → app, with the automatic encrypted cloud backup running. Multiple
 * tabs are supported via record-level IndexedDB storage. A no-login demo
 * keeps nothing.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { parseRecoveryKey } from "@mytowncart-billing/backup";
import { MarketplaceError, type CloudBackup } from "@mytowncart-billing/connector-mytowncart";
import { MemoryRepository, seedDemoData } from "@mytowncart-billing/storage";

import { t } from "../../i18n";
import {
  clearConnection,
  HOSTED_SIGNED_OUT_EVENT,
  loadConnection,
} from "../../lib/connection";
import { setRepository } from "../../lib/repository";
import {
  downloadAndOpen,
  listWebBackups,
  startCloudBackupScheduler,
  useCloudBackupStatus,
} from "../../lib/hosted/cloudBackup";
import { ensureBackupKey, rememberRestoredKey, serverKeySetting, type KeyMode } from "../../lib/hosted/backupKey";
import { DESKTOP_DOWNLOAD_URL } from "../../lib/hosted/mode";
import {
  finishHostedOAuthCallback,
  hasOAuthCallback,
  startHostedOAuthSignIn,
} from "../../lib/hosted/oauth";
import { openPersistedRepository, writeRepositoryState, type PersistedRepository } from "../../lib/hosted/persistedRepository";
import {
  isDemo,
  setDemo,
  setHostedRepository,
} from "../../lib/hosted/session";
import { subscribeTabEvents } from "../../lib/hosted/tabSync";
import { LegalLinks } from "./LegalLinks";
import { RecoveryKeyConfirm } from "./RecoveryKeyConfirm";

const card = "bg-white rounded-lg shadow p-8 w-full max-w-md space-y-4";
const btnPrimary =
  "w-full rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300";
const btnSecondary =
  "w-full rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50";
const inputCls =
  "mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none";

type Phase =
  | { kind: "checking" }
  | { kind: "storage_failed" }
  | { kind: "signin"; error?: string }
  | { kind: "other_shop" }
  | { kind: "backups_failed"; message: string }
  | { kind: "restoring" }
  | { kind: "restore"; backups: CloudBackup[]; mode: KeyMode | null; serverKey: Uint8Array | null }
  | { kind: "key_setup" }
  | { kind: "ready" }
  | { kind: "demo" };

function isAuthError(err: unknown): boolean {
  return err instanceof MarketplaceError && (err.code === "unauthorized" || err.code === "expired_token");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-100 flex flex-col items-center justify-start pt-12 pb-12 px-4 gap-6">
      <img
        src={`${import.meta.env.BASE_URL}brand/logo-full.svg`}
        alt="MyTownCart Billing"
        className="h-11 w-auto"
        data-testid="hosted-brand-logo"
      />
      <div className={card}>{children}</div>
    </main>
  );
}

function DownloadLink() {
  return (
    <div className="border-t border-gray-200 pt-4 text-sm text-gray-600">
      <p>{t("hosted.download_hint")}</p>
      <a
        href={DESKTOP_DOWNLOAD_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-block font-medium text-blue-700 underline"
        data-testid="hosted-download-desktop"
      >
        {t("hosted.download_desktop")}
      </a>
    </div>
  );
}

export function HostedGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const persistedRef = useRef<PersistedRepository | null>(null);
  const freshRef = useRef(false);
  const autoRestoreTriedRef = useRef(false);
  const stopSchedulerRef = useRef<(() => void) | null>(null);
  const bootRunIdRef = useRef(0);

  const boot = useCallback(async () => {
    const runId = ++bootRunIdRef.current;
    const isStale = () => bootRunIdRef.current !== runId;
    setPhase({ kind: "checking" });
    if (isDemo()) {
      const demo = new MemoryRepository();
      await seedDemoData(demo);
      if (isStale()) return;
      setRepository(demo);
      setPhase({ kind: "demo" });
      return;
    }
    // Ask the browser not to evict our data under storage pressure.
    void navigator.storage?.persist?.().catch(() => false);
    try {
      persistedRef.current ??= await openPersistedRepository();
    } catch {
      if (!isStale()) setPhase({ kind: "storage_failed" });
      return;
    }
    if (isStale()) return;
    const persisted = persistedRef.current;
    setRepository(persisted.repo);
    setHostedRepository(persisted);

    if (hasOAuthCallback()) {
      try {
        const result = await finishHostedOAuthCallback(persisted);
        if (isStale()) return;
        if (!result.ok) {
          if (result.otherShop) {
            setPhase({ kind: "other_shop" });
            return;
          }
          const msg =
            result.code === "missing_scope"
              ? t("hosted.signin_missing_scope")
              : t("hosted.signin_failed", { message: result.message });
          setPhase({ kind: "signin", error: msg });
          return;
        }
      } catch (err) {
        if (!isStale()) setPhase({ kind: "signin", error: t("hosted.signin_failed", { message: errorText(err) }) });
        return;
      }
    }

    if (!(await loadConnection({ force: true }))) {
      if (!isStale()) setPhase({ kind: "signin" });
      return;
    }
    if (isStale()) return;
    if ((await persisted.isEmpty()) && !freshRef.current) {
      if (isStale()) return;
      try {
        const backups = await listWebBackups();
        if (isStale()) return;
        if (backups.length > 0) {
          const server = await serverKeySetting();
          if (isStale()) return;
          const newest = backups[0]!;
          if (server?.key && !autoRestoreTriedRef.current) {
            // Managed key: bring the shop back with nothing to type.
            autoRestoreTriedRef.current = true;
            setPhase({ kind: "restoring" });
            const opened = await downloadAndOpen(newest.id, server.key);
            if (isStale()) return;
            if (opened.ok) {
              await writeRepositoryState(opened.state);
              await rememberRestoredKey(opened.key, "managed", true);
              window.location.reload();
              return;
            }
          }
          setPhase({ kind: "restore", backups, mode: server?.mode ?? null, serverKey: server?.key ?? null });
          return;
        }
      } catch (err) {
        if (isStale()) return;
        if (isAuthError(err)) {
          await clearConnection();
          return;
        }
        setPhase({ kind: "backups_failed", message: errorText(err) });
        return;
      }
    }
    try {
      if ((await ensureBackupKey()) === "private_setup") {
        if (!isStale()) setPhase({ kind: "key_setup" });
        return;
      }
    } catch (err) {
      if (isStale()) return;
      if (isAuthError(err)) {
        await clearConnection();
        return;
      }
      setPhase({ kind: "backups_failed", message: errorText(err) });
      return;
    }
    if (isStale()) return;
    if (!stopSchedulerRef.current) {
      stopSchedulerRef.current = await startCloudBackupScheduler(persisted, () => void clearConnection());
    }
    if (isStale()) return;
    setPhase({ kind: "ready" });
  }, []);

  useEffect(() => {
    void boot();
    const onSignedOut = () => {
      stopSchedulerRef.current?.();
      stopSchedulerRef.current = null;
      setPhase({ kind: "signin" });
    };
    const stopTabEvents = subscribeTabEvents((msg) => {
      if (msg.type === "signed_out" || msg.type === "restored") {
        window.location.reload();
      } else if (msg.type === "signed_in" && phaseRef.current.kind === "signin") {
        void boot();
      } else if (msg.type === "token_refreshed") {
        void loadConnection({ force: true });
      }
    });
    window.addEventListener(HOSTED_SIGNED_OUT_EVENT, onSignedOut);
    return () => {
      bootRunIdRef.current++;
      window.removeEventListener(HOSTED_SIGNED_OUT_EVENT, onSignedOut);
      stopTabEvents();
      stopSchedulerRef.current?.();
    };
  }, [boot]);

  switch (phase.kind) {
    case "checking":
      return <main className="p-8 text-gray-600">{t("common.loading")}</main>;
    case "restoring":
      return (
        <Screen>
          <p className="text-sm text-gray-700" data-testid="hosted-auto-restoring">{t("hosted.restoring_auto")}</p>
        </Screen>
      );
    case "storage_failed":
      return (
        <Screen>
          <p className="text-sm text-red-700" data-testid="hosted-storage-failed">{t("hosted.storage_failed")}</p>
        </Screen>
      );
    case "signin":
      return (
        <SignIn
          initialError={phase.error}
          onDemo={() => {
            setDemo(true);
            window.location.reload();
          }}
        />
      );
    case "other_shop":
      return (
        <Screen>
          <p className="text-sm text-red-700" data-testid="hosted-other-shop">{t("hosted.other_shop")}</p>
          <button type="button" className={btnSecondary} onClick={() => setPhase({ kind: "signin" })}>
            {t("hosted.retry")}
          </button>
        </Screen>
      );
    case "backups_failed":
      return (
        <Screen>
          <p className="text-sm text-red-700">{t("hosted.backups_failed", { message: phase.message })}</p>
          <button type="button" className={btnPrimary} onClick={() => void boot()}>
            {t("hosted.retry")}
          </button>
        </Screen>
      );
    case "restore":
      return (
        <Restore
          backups={phase.backups}
          mode={phase.mode}
          serverKey={phase.serverKey}
          onStartFresh={() => {
            freshRef.current = true;
            void boot();
          }}
        />
      );
    case "key_setup":
      return (
        <Screen>
          <RecoveryKeyConfirm
            title={t("hosted.key_title")}
            intro={t("hosted.key_intro")}
            onConfirmed={async (raw) => {
              await rememberRestoredKey(raw, "private", false);
              void boot();
            }}
          />
        </Screen>
      );
    case "demo":
      return (
        <>
          {children}
          <div className="fixed bottom-3 left-1/2 z-50 -translate-x-1/2 flex items-center gap-3 rounded-full bg-amber-100 border border-amber-300 px-4 py-2 text-sm text-amber-900 shadow" data-testid="hosted-demo-banner">
            <span>{t("hosted.demo_banner")}</span>
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => {
                setDemo(false);
                window.location.reload();
              }}
            >
              {t("hosted.exit_demo")}
            </button>
          </div>
        </>
      );
    case "ready":
      return (
        <>
          {children}
          <BackupOverdueNotice />
        </>
      );
  }
}

function SignIn(props: {
  initialError?: string;
  onDemo: () => void;
}) {
  const [error, setError] = useState<string | null>(props.initialError ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.initialError) setError(props.initialError);
  }, [props.initialError]);

  const signIn = async () => {
    setError(null);
    setBusy(true);
    try {
      await startHostedOAuthSignIn();
    } catch (err) {
      setError(t("hosted.signin_failed", { message: errorText(err) }));
      setBusy(false);
    }
  };

  return (
    <Screen>
      <h1 className="text-xl font-bold">{t("hosted.signin_title")}</h1>
      <p className="text-sm text-gray-600">{t("hosted.signin_intro")}</p>
      {error ? <p className="text-sm text-red-700" data-testid="hosted-signin-error">{error}</p> : null}
      <button type="button" className={btnPrimary} disabled={busy} onClick={() => void signIn()} data-testid="hosted-signin">
        {t("hosted.signin_button")}
      </button>
      <button type="button" className={btnSecondary} disabled={busy} onClick={props.onDemo} data-testid="hosted-demo">
        {t("hosted.demo_button")}
      </button>
      <DownloadLink />
      <LegalLinks note />
    </Screen>
  );
}

function Restore(props: {
  backups: CloudBackup[];
  mode: KeyMode | null;
  serverKey: Uint8Array | null;
  onStartFresh: () => void;
}) {
  const [selected, setSelected] = useState(props.backups[0]?.id ?? "");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const restore = async () => {
    setError(null);
    // Managed shops can restore with the key MyTownCart keeps; a typed key
    // (an older one the seller saved) wins when given.
    const useServerKey = key.trim() === "" && props.serverKey !== null;
    if (!useServerKey && parseRecoveryKey(key) === null) {
      setError(t("hosted.restore_bad_key"));
      return;
    }
    setBusy(true);
    try {
      const opened = await downloadAndOpen(selected, useServerKey ? props.serverKey! : key);
      if (!opened.ok) {
        setError(
          opened.error === "wrong_key" ? t("hosted.restore_wrong_key")
            : opened.error === "bad_key" ? t("hosted.restore_bad_key")
              : t("hosted.restore_corrupt"),
        );
        return;
      }
      await writeRepositoryState(opened.state);
      // Managed shops hand the key to the server before the next backup; if
      // the server already holds a different one, that one is adopted then.
      await rememberRestoredKey(opened.key, props.mode ?? "managed", useServerKey);
      window.location.reload();
    } catch (err) {
      setError(t("hosted.backups_failed", { message: errorText(err) }));
    } finally {
      setBusy(false);
    }
  };

  const startFresh = () => {
    if (window.confirm(t("hosted.start_fresh_confirm"))) props.onStartFresh();
  };

  return (
    <Screen>
      <h1 className="text-xl font-bold">{t("hosted.restore_title")}</h1>
      <p className="text-sm text-gray-600">
        {props.serverKey ? t("hosted.restore_auto_failed") : t("hosted.restore_intro")}
      </p>
      <label className="block">
        <span className="text-sm font-medium">{t("hosted.restore_pick")}</span>
        <select
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          data-testid="hosted-restore-pick"
        >
          {props.backups.map((b) => (
            <option key={b.id} value={b.id}>
              {new Date(b.createdAt).toLocaleString()} · {Math.max(1, Math.round(b.sizeBytes / 1024))} KB
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-sm font-medium">
          {props.serverKey ? t("hosted.restore_key_optional") : t("hosted.restore_key")}
        </span>
        <input
          className={inputCls}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="XXXX XXXX XXXX XXXX XXXX XXXX XXXX XXXX"
          autoComplete="off"
          spellCheck={false}
          data-testid="hosted-restore-key"
        />
      </label>
      {error ? <p className="text-sm text-red-700" data-testid="hosted-restore-error">{error}</p> : null}
      <button type="button" className={btnPrimary} disabled={busy || !selected} onClick={() => void restore()} data-testid="hosted-restore">
        {busy ? t("hosted.restoring") : t("hosted.restore_button")}
      </button>
      <button type="button" className={btnSecondary} disabled={busy} onClick={startFresh} data-testid="hosted-start-fresh">
        {t("hosted.start_fresh")}
      </button>
    </Screen>
  );
}

/** Quiet unless the cloud copy is more than a day behind. */
function BackupOverdueNotice() {
  const status = useCloudBackupStatus();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5 * 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!status.pending || status.lastSuccessAt === null) return null;
  const hours = Math.floor((now - Date.parse(status.lastSuccessAt)) / 3_600_000);
  if (hours < 24) return null;
  return (
    <div className="fixed bottom-3 right-3 z-50 max-w-sm rounded border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 shadow" data-testid="hosted-backup-overdue">
      {t("hosted.backup_overdue", { hours })}
    </div>
  );
}
