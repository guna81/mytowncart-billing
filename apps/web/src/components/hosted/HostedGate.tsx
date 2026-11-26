// SPDX-License-Identifier: Apache-2.0
/**
 * Startup gate for the hosted web app (D13). Before the billing UI renders:
 * one tab only → MyTownCart sign-in (mandatory) → restore from a cloud backup
 * when this browser is empty → recovery key set up → app, with the automatic
 * encrypted cloud backup running. A no-login demo keeps nothing.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { formatRecoveryKey, parseRecoveryKey } from "@mytowncart-billing/backup";
import { MarketplaceError, scopeNames, type CloudBackup } from "@mytowncart-billing/connector-mytowncart";
import { MemoryRepository, seedDemoData } from "@mytowncart-billing/storage";

import { t } from "../../i18n";
import { createRecoveryKey, hasRecoveryKey, saveRecoveryKey } from "../../lib/cryptoStore";
import {
  clearConnection,
  HOSTED_SIGNED_OUT_EVENT,
  loadConnection,
  saveConnection,
} from "../../lib/connection";
import { getConnector } from "../../lib/marketplace";
import { setRepository } from "../../lib/repository";
import {
  downloadAndOpen,
  listWebBackups,
  startCloudBackupScheduler,
  useCloudBackupStatus,
} from "../../lib/hosted/cloudBackup";
import { hostedInvoke } from "../../lib/hosted/keystore";
import { DESKTOP_DOWNLOAD_URL, HOSTED_CLIENT_NAME } from "../../lib/hosted/mode";
import { openPersistedRepository, writeRepositoryState, type PersistedRepository } from "../../lib/hosted/persistedRepository";
import {
  dataOwner,
  isDemo,
  setDataOwner,
  setDemo,
  setHostedRepository,
} from "../../lib/hosted/session";
import { acquireAppLock } from "../../lib/hosted/singleTab";

const card = "bg-white rounded-lg shadow p-8 w-full max-w-md space-y-4";
const btnPrimary =
  "w-full rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300";
const btnSecondary =
  "w-full rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50";
const inputCls =
  "mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none";

type Phase =
  | { kind: "checking" }
  | { kind: "other_tab" }
  | { kind: "storage_failed" }
  | { kind: "signin" }
  | { kind: "other_shop" }
  | { kind: "backups_failed"; message: string }
  | { kind: "restore"; backups: CloudBackup[] }
  | { kind: "key_setup" }
  | { kind: "ready" }
  | { kind: "demo" };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-100 flex items-start justify-center pt-16 px-4">
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
  const persistedRef = useRef<PersistedRepository | null>(null);
  const lockRef = useRef(false);
  const freshRef = useRef(false);
  const stopSchedulerRef = useRef<(() => void) | null>(null);

  const boot = useCallback(async () => {
    setPhase({ kind: "checking" });
    if (isDemo()) {
      const demo = new MemoryRepository();
      await seedDemoData(demo);
      setRepository(demo);
      setPhase({ kind: "demo" });
      return;
    }
    if (!lockRef.current) {
      lockRef.current = await acquireAppLock();
      if (!lockRef.current) {
        setPhase({ kind: "other_tab" });
        return;
      }
    }
    // Ask the browser not to evict our data under storage pressure.
    void navigator.storage?.persist?.().catch(() => false);
    try {
      persistedRef.current ??= await openPersistedRepository();
    } catch {
      setPhase({ kind: "storage_failed" });
      return;
    }
    const persisted = persistedRef.current;
    setRepository(persisted.repo);
    setHostedRepository(persisted);

    if (!(await loadConnection({ force: true }))) {
      setPhase({ kind: "signin" });
      return;
    }
    if ((await persisted.isEmpty()) && !freshRef.current) {
      try {
        const backups = await listWebBackups();
        if (backups.length > 0) {
          setPhase({ kind: "restore", backups });
          return;
        }
      } catch (err) {
        if (err instanceof MarketplaceError && err.code === "unauthorized") {
          await clearConnection();
          return;
        }
        setPhase({ kind: "backups_failed", message: errorText(err) });
        return;
      }
    }
    if (!(await hasRecoveryKey(hostedInvoke))) {
      setPhase({ kind: "key_setup" });
      return;
    }
    if (!stopSchedulerRef.current) {
      stopSchedulerRef.current = await startCloudBackupScheduler(persisted, () => void clearConnection());
    }
    setPhase({ kind: "ready" });
  }, []);

  useEffect(() => {
    void boot();
    const onSignedOut = () => {
      stopSchedulerRef.current?.();
      stopSchedulerRef.current = null;
      setPhase({ kind: "signin" });
    };
    window.addEventListener(HOSTED_SIGNED_OUT_EVENT, onSignedOut);
    return () => {
      window.removeEventListener(HOSTED_SIGNED_OUT_EVENT, onSignedOut);
      stopSchedulerRef.current?.();
    };
  }, [boot]);

  switch (phase.kind) {
    case "checking":
      return <main className="p-8 text-gray-600">{t("common.loading")}</main>;
    case "other_tab":
      return (
        <Screen>
          <h1 className="text-xl font-bold">{t("hosted.other_tab_title")}</h1>
          <p className="text-sm text-gray-600">{t("hosted.other_tab_body")}</p>
          <button type="button" className={btnPrimary} onClick={() => window.location.reload()}>
            {t("hosted.reload")}
          </button>
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
          onSignedIn={() => void boot()}
          onOtherShop={() => setPhase({ kind: "other_shop" })}
          onDemo={() => {
            setDemo(true);
            window.location.reload();
          }}
          persisted={persistedRef.current}
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
          onStartFresh={() => {
            freshRef.current = true;
            void boot();
          }}
        />
      );
    case "key_setup":
      return <KeySetup onDone={() => void boot()} />;
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
  onSignedIn: () => void;
  onOtherShop: () => void;
  onDemo: () => void;
  persisted: PersistedRepository | null;
}) {
  const [code, setCode] = useState<{ userCode: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setError(null);
    setBusy(true);
    try {
      const connector = getConnector();
      const session = await connector.connect(HOSTED_CLIENT_NAME, ["catalog", "stock", "orders", "backups"]);
      setCode({ userCode: session.userCode, url: session.verificationUrl });
      window.open(session.verificationUrl, "_blank", "noopener,noreferrer");
      await session.waitForApproval();
      const minted = connector.takeMintedToken();
      if (!minted) throw new Error("no token");
      if (!scopeNames(["backups"]).every((s) => minted.scopes.includes(s))) {
        setError(t("hosted.signin_missing_scope"));
        return;
      }
      await saveConnection(minted);
      const me = await connector.me();
      const owner = await dataOwner();
      const hasData = props.persisted ? !(await props.persisted.isEmpty()) : false;
      if (owner && owner !== me.sellerId && hasData) {
        // Never back one shop's bills up into another seller's account.
        await clearConnection();
        props.onOtherShop();
        return;
      }
      await setDataOwner(me.sellerId);
      props.onSignedIn();
    } catch (err) {
      setError(t("hosted.signin_failed", { message: errorText(err) }));
    } finally {
      setBusy(false);
      setCode(null);
    }
  };

  return (
    <Screen>
      <h1 className="text-xl font-bold">{t("hosted.signin_title")}</h1>
      <p className="text-sm text-gray-600">{t("hosted.signin_intro")}</p>
      {code ? (
        <div className="rounded border border-blue-200 bg-blue-50 p-4 text-center space-y-2" data-testid="hosted-signin-code">
          <p className="text-sm text-gray-700">{t("hosted.signin_code")}</p>
          <p className="font-mono text-2xl font-bold tracking-widest">{code.userCode}</p>
          <a href={code.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-blue-700 underline">
            {t("hosted.signin_open")}
          </a>
          <p className="text-xs text-gray-500">{t("hosted.signin_waiting")}</p>
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-700" data-testid="hosted-signin-error">{error}</p> : null}
      <button type="button" className={btnPrimary} disabled={busy} onClick={() => void signIn()} data-testid="hosted-signin">
        {t("hosted.signin_button")}
      </button>
      <button type="button" className={btnSecondary} disabled={busy} onClick={props.onDemo} data-testid="hosted-demo">
        {t("hosted.demo_button")}
      </button>
      <DownloadLink />
    </Screen>
  );
}

function Restore(props: { backups: CloudBackup[]; onStartFresh: () => void }) {
  const [selected, setSelected] = useState(props.backups[0]?.id ?? "");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const restore = async () => {
    setError(null);
    if (parseRecoveryKey(key) === null) {
      setError(t("hosted.restore_bad_key"));
      return;
    }
    setBusy(true);
    try {
      const opened = await downloadAndOpen(selected, key);
      if (!opened.ok) {
        setError(
          opened.error === "wrong_key" ? t("hosted.restore_wrong_key")
            : opened.error === "bad_key" ? t("hosted.restore_bad_key")
              : t("hosted.restore_corrupt"),
        );
        return;
      }
      await writeRepositoryState(opened.state);
      await saveRecoveryKey(hostedInvoke, opened.key);
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
      <p className="text-sm text-gray-600">{t("hosted.restore_intro")}</p>
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
        <span className="text-sm font-medium">{t("hosted.restore_key")}</span>
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

function printKey(key: string): void {
  const w = window.open("", "_blank", "width=640,height=420");
  if (!w) return;
  // The key is base32 + spaces only; anything else is stripped before it goes into markup.
  w.document.write(
    `<!doctype html><title>MyTownCart Billing recovery key</title>` +
      `<body style="font-family:sans-serif;padding:32px">` +
      `<h2>MyTownCart Billing — recovery key</h2>` +
      `<p style="font:bold 22px monospace;letter-spacing:2px">${key.replace(/[^A-Z0-9 -]/gi, "")}</p>` +
      `<p>${new Date().toLocaleString()}</p>` +
      `<p>Keep this safe. Without it, backups of this shop cannot be opened.</p></body>`,
  );
  w.document.close();
  w.focus();
  w.print();
}

function KeySetup({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [ack, setAck] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const created = useRef(false);

  useEffect(() => {
    if (created.current) return;
    created.current = true;
    void createRecoveryKey(hostedInvoke).then(setKey, (err) => setError(errorText(err)));
  }, []);

  const typedRaw = parseRecoveryKey(typed);
  const matches = key !== null && typedRaw !== null && formatRecoveryKey(typedRaw) === key;

  return (
    <Screen>
      <h1 className="text-xl font-bold">{t("hosted.key_title")}</h1>
      <p className="text-sm text-gray-600">{t("hosted.key_intro")}</p>
      {key ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-center font-mono text-lg font-bold tracking-wider break-all" data-testid="hosted-key">
          {key}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="button" className={btnSecondary} disabled={!key} onClick={() => key && printKey(key)}>
          {t("hosted.key_print")}
        </button>
        <button
          type="button"
          className={btnSecondary}
          disabled={!key}
          onClick={() => {
            if (!key) return;
            void navigator.clipboard.writeText(key).then(() => setCopied(true));
          }}
        >
          {copied ? t("hosted.key_copied") : t("hosted.key_copy")}
        </button>
      </div>
      <label className="block">
        <span className="text-sm font-medium">{t("hosted.key_confirm_label")}</span>
        <input
          className={inputCls}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          onPaste={(e) => e.preventDefault()}
          data-testid="hosted-key-confirm"
        />
      </label>
      {typed.trim() !== "" && !matches ? (
        <p className="text-sm text-amber-800">{t("hosted.key_confirm_mismatch")}</p>
      ) : null}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="hosted-key-ack" />
        <span>{t("hosted.key_ack")}</span>
      </label>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <button type="button" className={btnPrimary} disabled={!matches || !ack} onClick={onDone} data-testid="hosted-key-continue">
        {t("hosted.key_continue")}
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
