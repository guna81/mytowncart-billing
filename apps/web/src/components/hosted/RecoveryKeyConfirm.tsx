// SPDX-License-Identifier: Apache-2.0
/**
 * Show a new recovery key and make the seller prove they saved it (typed,
 * paste blocked, plus an acknowledgement) before `onConfirmed` runs. Used only
 * for private key mode (D13 rev): in the default managed mode MyTownCart keeps
 * the key and the seller never sees this.
 *
 * The key is held in memory until confirmed, so a reload mid-way shows a new
 * key rather than silently keeping one nobody wrote down.
 */
import { useState } from "react";

import { formatRecoveryKey, parseRecoveryKey } from "@mytowncart-billing/backup";

import { t } from "../../i18n";
import { newPrivateKey } from "../../lib/hosted/backupKey";

const btnPrimary =
  "w-full rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300";
const btnSecondary =
  "w-full rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50";
const inputCls =
  "mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none";

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

export function RecoveryKeyConfirm(props: {
  title: string;
  intro: string;
  onConfirmed: (raw: Uint8Array) => Promise<void>;
  onCancel?: () => void;
}) {
  const [fresh] = useState(newPrivateKey);
  const [typed, setTyped] = useState("");
  const [ack, setAck] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = fresh.text;
  const typedRaw = parseRecoveryKey(typed);
  const matches = typedRaw !== null && formatRecoveryKey(typedRaw) === key;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onConfirmed(fresh.raw);
    } catch (err) {
      setError(t("hosted.mode_change_failed", { message: err instanceof Error ? err.message : String(err) }));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="hosted-key-setup">
      <h2 className="text-xl font-bold">{props.title}</h2>
      <p className="text-sm text-gray-600">{props.intro}</p>
      <p className="rounded border border-amber-300 bg-amber-50 p-3 text-center font-mono text-lg font-bold tracking-wider break-all" data-testid="hosted-key">
        {key}
      </p>
      <div className="flex gap-2">
        <button type="button" className={btnSecondary} onClick={() => printKey(key)}>
          {t("hosted.key_print")}
        </button>
        <button
          type="button"
          className={btnSecondary}
          onClick={() => void navigator.clipboard.writeText(key).then(() => setCopied(true))}
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
      <button
        type="button"
        className={btnPrimary}
        disabled={!matches || !ack || busy}
        onClick={() => void confirm()}
        data-testid="hosted-key-continue"
      >
        {t("hosted.key_continue")}
      </button>
      {props.onCancel ? (
        <button type="button" className={btnSecondary} disabled={busy} onClick={props.onCancel}>
          {t("common.cancel")}
        </button>
      ) : null}
    </div>
  );
}
