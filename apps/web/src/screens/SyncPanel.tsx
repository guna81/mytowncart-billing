// SPDX-License-Identifier: Apache-2.0
/**
 * Overview tab (B5, roadmap §8.6): one status strip, a manual "Sync now", and the
 * "needs attention" reconcile list (per-row choices). Scheduling and options
 * live in SyncSettingsPanel; background timers live ONLY in lib/autoSync.ts.
 */
import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import {
  formatPaise,
  localIsoTimestamp,
  type ReconcileKind,
  type ReconcileRow,
} from "@mytowncart-billing/core";
import type { PlatformProduct } from "@mytowncart-billing/connector-mytowncart";
import type { Item, StockReconciliationIntent, StockSourceResolution, OutboxRow } from "@mytowncart-billing/storage";
import { t, type I18nKey } from "../i18n";
import { runAutoSync, SYNC_LAST_KEY, withReconciliationLock } from "../lib/autoSync";
import { applyReconciliation, bootstrapStock, exceptionalStockSourceEligible, stockRecoveryConsentMatches, recoverStockShortage, reconcileMappedSource, reconcileFixes, validateReconcileTargets } from "../lib/reconcileFixes";
import { getConnector } from "../lib/marketplace";
import {
  loadPlatformOnly,
  removeFromPlatformOnly,
  type PlatformOnlySnapshot,
} from "../lib/platformOnly";
import { pullPlatformProducts } from "../lib/pullService";
import { getRepository } from "../lib/repository";
import { friendlyProblem } from "../lib/syncLabels";
import {
  getReconcileSnapshot,
  syncAvailable,
  type SyncOutcome,
} from "../lib/syncEngine";
import { useAppStore } from "../store/appStore";
import { confirmAction } from "../lib/shell";

const btnPrimary =
  "rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300";
const btnSecondary =
  "rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50";

const PAGE_SIZE = 10;

export function usePagination<T>(items: readonly T[]) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);

  useEffect(() => {
    setPage((previous) => Math.min(previous, pageCount));
  }, [pageCount]);

  return {
    page: currentPage,
    pageCount,
    setPage,
    visible: items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
  };
}

export function Pagination({ page, pageCount, setPage, label }: {
  page: number;
  pageCount: number;
  setPage: (page: number) => void;
  label: string;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label={label} className="mt-3 flex flex-wrap items-center gap-3 text-sm">
      <button type="button" className={`${btnSecondary} disabled:opacity-50`} disabled={page === 1} onClick={() => setPage(page - 1)}>
        {t("page.previous")}
      </button>
      <span aria-live="polite">{t("page.status", { page, total: pageCount })}</span>
      <button type="button" className={`${btnSecondary} disabled:opacity-50`} disabled={page === pageCount} onClick={() => setPage(page + 1)}>
        {t("page.next")}
      </button>
    </nav>
  );
}

interface LastSync {
  at: string;
  outcome: SyncOutcome;
}

async function loadLastSync(): Promise<LastSync | null> {
  const raw = await getRepository().getAppSetting(SYNC_LAST_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as LastSync;
  } catch {
    return null;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SyncPanel({
  part = "overview",
  categoryMapping,
  itemStatus,
}: {
  /** "sync" = status strip + Sync now (Settings tab); "overview" = everything else. */
  part?: "overview" | "sync";
  categoryMapping?: ReactNode;
  itemStatus?: ReactNode;
}) {
  const dataVersion = useAppStore((s) => s.dataVersion);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);
  const autoSyncEnabled = useAppStore((s) => s.autoSyncEnabled);
  const isSyncing = useAppStore((s) => s.isSyncing);
  const [pending, setPending] = useState<OutboxRow[]>([]);
  const [quarantined, setQuarantined] = useState<OutboxRow[]>([]);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [uncertainCount, setUncertainCount] = useState(0);
  const [intents, setIntents] = useState<StockReconciliationIntent[]>([]);
  const [history, setHistory] = useState<StockSourceResolution[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [last, setLast] = useState<LastSync | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReconcileRow[] | null>(null);
  const [settling, setSettling] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [settleNote, setSettleNote] = useState<string | null>(null);
  const [onlyOnMtc, setOnlyOnMtc] = useState<PlatformOnlySnapshot | null>(null);
  const reconcilePage = usePagination(rows ?? []);

  const refresh = useCallback(async () => {
    const repo = getRepository();
    setPending(await repo.listOutbox("pending"));
    const resolutions = await repo.listStockSourceResolutions();
    setHistory(resolutions);
    setItems(await repo.listItems({ activeOnly: false }));
    setIntents(await repo.listStockReconciliations());
    setQuarantined((await repo.listOutbox("quarantined")).filter((source) => !resolutions.some((entry) => entry.sourceId === source.id && (entry.action === "historical_unknown" || !!entry.retiredBy))));
    setUncertainCount((await repo.listStockReconciliations()).filter((intent) => intent.status === "pending").length);
    setBootstrapRequired(await repo.getAppSetting("sync.stock_bootstrap_required") === "true" || !(await repo.getAppSetting("sync.stock_epoch")));
    setLast(await loadLastSync());
    setRows(await getReconcileSnapshot(repo));
    setOnlyOnMtc(await loadPlatformOnly());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, dataVersion]);

  // Manual sync shares the single in-flight guard with the background scheduler.
  const syncNow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await runAutoSync({ force: true, manual: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [refresh]);

  const [pulling, setPulling] = useState(false);
  const [pullNote, setPullNote] = useState<string | null>(null);
  const pull = useCallback(
    async (products: readonly PlatformProduct[]) => {
      setPulling(true);
      setPullNote(null);
      try {
        const connector = getConnector();
        const result = await pullPlatformProducts(
          getRepository(),
          connector,
          products,
          await connector.listCategories(),
        );
        await removeFromPlatformOnly(result.pulled);
        const lines: string[] = [];
        if (result.pulled.length > 0)
          lines.push(t("platform.pulled", { count: result.pulled.length }));
        for (const f of result.failed.slice(0, 3)) {
          lines.push(
            t("platform.pull_failed", { name: f.name, error: f.error }),
          );
        }
        setPullNote(lines.join(" "));
        bumpDataVersion();
      } catch (err) {
        setPullNote(errorText(err));
      } finally {
        setPulling(false);
        await refresh();
      }
    },
    [bumpDataVersion, refresh],
  );

  const dueCount = pending.filter(
    (p) =>
      p.nextAttemptAt === null ||
      p.nextAttemptAt <= localIsoTimestamp(new Date()),
  ).length;
  const settle = async (targets: readonly ReconcileRow[], pull: boolean) => {
    setSettling(true);
    setSettleError(null);
    setSettleNote(null);
    try {
      await withReconciliationLock(async () => {
        const fixes = reconcileFixes(targets, pull);
        if (fixes.length === 0) return;
        const repo = getRepository();
        await validateReconcileTargets(targets.filter((row) => fixes.some((fix) =>
          fix.itemId === row.itemId && fix.externalId === row.externalId && fix.kind === row.kind)), repo, getConnector(), rows ?? []);
        await applyReconciliation(targets, pull, repo, getConnector());
        bumpDataVersion();
        await refresh();
      });
      setSettleNote(t(pull ? "reconcile.pulled" : "reconcile.applied"));
    } catch (err) {
      setSettleError(errorText(err));
    } finally {
      setSettling(false);
      await refresh();
    }
  };

  const bootstrap = async (pull: boolean) => {
    if (!await confirmAction(t(pull ? "sync.bootstrap_remote_confirm" : "sync.bootstrap_local_confirm"))) return;
    setSettling(true);
    setSettleError(null);
    try {
      await withReconciliationLock(() => bootstrapStock(getRepository(), getConnector(), pull));
      bumpDataVersion();
    } catch (err) { setSettleError(errorText(err)); }
    finally { setSettling(false); await refresh(); }
  };

  const problems = last?.outcome.problems ?? [];
  const working = busy || isSyncing;
  const status: {
    key: I18nKey;
    tone: "ok" | "work" | "warn" | "info";
    vars?: Record<string, number>;
  } = working
    ? { key: "sync.status.syncing", tone: "work" }
    : error
      ? { key: "sync.status.attention", tone: "warn" }
      : problems.length > 0
        ? { key: "sync.status.partial", tone: "warn" }
        : last?.outcome.retryAfterSeconds !== undefined
          ? { key: "sync.status.waiting", tone: "info" }
          : pending.length > 0
            ? {
                key: "sync.status.pending",
                tone: "info",
                vars: { count: pending.length },
              }
            : !autoSyncEnabled
              ? { key: "sync.status.paused", tone: "info" }
              : { key: "sync.status.synced", tone: "ok" };
  const toneClass = {
    ok: "bg-green-50 text-green-900 border-green-200",
    work: "bg-blue-50 text-blue-900 border-blue-200",
    warn: "bg-amber-50 text-amber-900 border-amber-200",
    info: "bg-gray-50 text-gray-800 border-gray-200",
  }[status.tone];

  return (
    <div className="space-y-4" data-testid="sync-panel">
      <StockRecoverySection sources={quarantined} intents={intents} history={history} items={items} disabled={busy || isSyncing || settling} onRefresh={async () => { bumpDataVersion(); await refresh(); }} />
      {(quarantined.length > 0 || uncertainCount > 0) && (
        <section className="rounded border border-amber-400 bg-amber-50 p-4 text-amber-950" role="status" data-testid="sync-quarantined">
          <p>{t("sync.quarantined", { count: quarantined.length })}</p>
          {uncertainCount > 0 && <p>{t("sync.uncertain", { count: uncertainCount })}</p>}
          <ul className="mt-2 list-inside list-disc text-sm">
            {quarantined.map((entry) => <li key={entry.idempotencyKey}>{entry.externalId || t("sync.unknown_source")}: {entry.quarantineReason ?? t("sync.review_required")}</li>)}
          </ul>
        </section>
      )}
      {part === "sync" && bootstrapRequired && (
        <section className="space-y-2 rounded border border-amber-400 bg-amber-50 p-4 text-amber-950" data-testid="stock-bootstrap">
          <p>{t("sync.bootstrap_needed")}</p>
          {settling && <p role="status" className="text-sm">{t("sync.status.syncing")}</p>}
          {settleError && <p role="alert" className="text-sm text-red-700">{settleError}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnSecondary} disabled={working || !syncAvailable()} onClick={() => void bootstrap(false)}>{t("sync.bootstrap_local")}</button>
            <button type="button" className={btnSecondary} disabled={working || !syncAvailable()} onClick={() => void bootstrap(true)}>{t("sync.bootstrap_remote")}</button>
          </div>
        </section>
      )}
      {part === "sync" ? (
        <section
          className={`rounded border p-4 ${toneClass}`}
          data-testid="sync-status"
          role="status"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-semibold" data-testid="sync-status-text">
                {t(status.key, status.vars)}
              </p>
              <p className="mt-0.5 text-sm" data-testid="sync-last">
                {last
                  ? t("sync.last", { when: new Date(last.at).toLocaleString() })
                  : t("sync.never")}
              </p>
            </div>
            <button
              type="button"
              className={btnPrimary}
              data-testid="sync-now"
              disabled={working || !syncAvailable()}
              onClick={() => void syncNow()}
            >
              {working ? t("sync.syncing") : t("sync.now")}
            </button>
          </div>
          {!syncAvailable() ? (
            <p className="mt-2 text-sm" data-testid="sync-desktop-only">
              {t("sync.desktop_only")}
            </p>
          ) : null}
          <p className="mt-2 text-xs opacity-80">{t("sync.lag_note")}</p>
          <p className="mt-1 text-xs opacity-80" data-testid="sync-orders-hint">
            {t("sync.orders_hint")}
          </p>
          {pending.length > 0 ? (
            <p className="mt-1 text-sm" data-testid="sync-pending">
              {dueCount > 0
                ? t("sync.pending", { count: pending.length })
                : t("sync.pending_retry", { count: pending.length })}
            </p>
          ) : null}
          {working && last ? (
            <p className="mt-1 text-xs opacity-80">{t("sync.previous_result")}</p>
          ) : null}
          {last ? (
            <p className="mt-1 text-sm" data-testid="sync-summary">
              {t("sync.done_shipped", {
                moves: last.outcome.pushedMoves,
                pulled: last.outcome.pulledMoves,
                restocked: last.outcome.restocked,
              })}
            </p>
          ) : null}
          {(last?.outcome.pulledItems ?? 0) +
            (last?.outcome.pulledPrices ?? 0) +
            (last?.outcome.pulledNames ?? 0) +
            (last?.outcome.pulledDescriptions ?? 0) +
            (last?.outcome.pulledPhotos ?? 0) >
          0 ? (
            <p className="mt-1 text-sm" data-testid="sync-pulled">
              {t("sync.pulled_from_mtc", {
                items: last?.outcome.pulledItems ?? 0,
                prices:
                  (last?.outcome.pulledPrices ?? 0) +
                  (last?.outcome.pulledNames ?? 0) +
                  (last?.outcome.pulledDescriptions ?? 0) +
                  (last?.outcome.pulledPhotos ?? 0),
              })}
            </p>
          ) : null}
          {problems.length > 0 ? (
            <div
              className="mt-2 rounded bg-white/70 p-2"
              data-testid="sync-problems"
            >
              <p className="text-sm">{t("sync.problems")}</p>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {problems.slice(0, 8).map((p) => (
                  <li key={p} title={p}>
                    {friendlyProblem(p)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {error ? (
            <p className="mt-2 text-sm text-red-600" data-testid="sync-error">
              {error}
            </p>
          ) : null}
        </section>
      ) : (
        <>
          {categoryMapping}

          <section
            className="rounded border border-gray-200 bg-white p-4"
            data-testid="reconcile"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">{t("reconcile.title")}</h2>
              <button
                type="button"
                className={btnSecondary}
                onClick={() => void refresh()}
              >
                {t("reconcile.refresh")}
              </button>
            </div>
            <p className="mt-1 text-sm text-gray-600">{t("reconcile.intro")}</p>
            {settleError && <p role="alert" className="mt-2 text-sm text-red-700">{settleError}</p>}
            {settleNote && <p role="status" className="mt-2 text-sm text-blue-700">{settleNote}</p>}
            {rows === null ? (
              <p className="mt-2 text-sm text-amber-700" data-testid="reconcile-unavailable">{t("reconcile.unavailable")}</p>
            ) : rows.length === 0 ? (
              <p
                className="mt-2 text-sm text-gray-500"
                data-testid="reconcile-none"
              >
                {t("reconcile.none")}
              </p>
            ) : (
              <>
                <table className="mt-3 w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase text-gray-500">
                      <th className="py-1">{t("reconcile.item")}</th>
                      <th className="py-1">{t("reconcile.kind")}</th>
                      <th className="py-1 text-right">
                        {t("reconcile.local")}
                      </th>
                      <th className="py-1 text-right">
                        {t("reconcile.remote")}
                      </th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {reconcilePage.visible.map((row) => (
                      <tr
                        key={`${row.itemId}:${row.kind}`}
                        className="border-t border-gray-100"
                        data-testid={`reconcile-${row.itemId}-${row.kind}`}
                      >
                        <td className="py-1 font-medium">{row.name}</td>
                        <td className="py-1">
                          {t(`reconcile.kind.${row.kind}` as I18nKey)}
                        </td>
                        <td className="py-1 text-right">
                          {valueText(row.kind, row.localValue)}
                        </td>
                        <td className="py-1 text-right">
                          {valueText(row.kind, row.remoteValue)}
                        </td>
                        <td className="py-1 text-right whitespace-nowrap">
                          <button
                            type="button"
                            className="mr-1 rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50"
                            data-testid={`reconcile-keep-${row.itemId}-${row.kind}`}
                            disabled={settling || isSyncing}
                            onClick={() => void settle([row], false)}
                          >
                            {t("reconcile.keep_mine")}
                          </button>
                          {row.kind !== "missing_remote" ? (
                            <button
                              type="button"
                              className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50"
                              data-testid={`reconcile-use-${row.itemId}-${row.kind}`}
                              disabled={settling || isSyncing}
                              onClick={() => void settle([row], true)}
                            >
                              {t("reconcile.use_market")}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pagination {...reconcilePage} label={t("page.reconcile")} />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={btnPrimary}
                    data-testid="reconcile-local"
                    disabled={settling || isSyncing}
                    onClick={() => void settle(rows, false)}
                  >
                    {t("reconcile.apply", { count: rows.length })}
                  </button>
                  {rows.some((r) => r.kind !== "missing_remote") ? (
                    <button
                      type="button"
                      className={btnSecondary}
                      data-testid="reconcile-pull"
                      disabled={settling || isSyncing}
                      onClick={() => void settle(rows, true)}
                    >
                      {t("reconcile.pull")}
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </section>

          {itemStatus}

          <PlatformOnlySection
            snapshot={onlyOnMtc}
            pulling={pulling}
            note={pullNote}
            onPull={(list) => void pull(list)}
          />
        </>
      )}
    </div>
  );
}

function StockRecoverySection({ sources, intents, history, items, disabled, onRefresh }: {
  sources: OutboxRow[]; intents: StockReconciliationIntent[]; history: StockSourceResolution[];
  items: Item[]; disabled: boolean; onRefresh: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(null);
  const [itemId, setItemId] = useState("");
  const reviewedSnapshot = JSON.stringify({ sources, intents, history, items, itemId, reason });
  const confirmed = stockRecoveryConsentMatches(confirmedSnapshot, reviewedSnapshot);
  useEffect(() => { if (confirmedSnapshot !== reviewedSnapshot) setConfirmedSnapshot(null); }, [confirmedSnapshot, reviewedSnapshot]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await withReconciliationLock(action); setReason(""); setConfirmedSnapshot(null); }
    catch (err) { setError(errorText(err)); }
    finally { setBusy(false); await onRefresh(); }
  };
  const reviews = intents.filter((entry) => entry.status === "needs_review" && !intents.some((child) => child.parentOperationId === entry.operationId && child.status !== "conflict"));
  if (!sources.length && !reviews.length && !history.length && !intents.length) return null;
  const blocked = disabled || busy || !confirmed || !reason.trim();
  // Only history (e.g. completed setup baselines) and nothing to decide: no form, no warning.
  const actionable = sources.length > 0 || reviews.length > 0;
  return <section className={actionable ? "space-y-3 rounded border border-amber-400 bg-amber-50 p-4" : "space-y-3 rounded border border-gray-200 bg-white p-4"} data-testid="stock-recovery">
    {actionable && <>
    <h2 className="font-semibold">{t("sync.recovery_title")}</h2>
    <p className="text-sm">{t("sync.recovery_warning")}</p>
    <label className="block">{t("sync.recovery_reason")}<textarea className="block w-full rounded border p-2" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmedSnapshot(event.target.checked ? reviewedSnapshot : null)} />{t("sync.recovery_confirm")}</label>
    {error && <p role="alert" className="text-red-700">{error}</p>}</>}
    {sources.some(exceptionalStockSourceEligible) && <label className="block">{t("sync.recovery_item")}<select className="ml-2 max-w-full rounded border p-2" value={itemId} onChange={(event) => setItemId(event.target.value)}><option value="">—</option>{items.filter((item) => item.remoteProductId !== null).map((item) => <option key={item.id} value={item.id}>{item.name} (itm_{item.id})</option>)}</select></label>}
    {sources.map((source) => {
      const mapped = history.find((entry) => entry.sourceId === source.id && entry.action === "map" && !entry.retiredBy);
      const mappedItem = items.find((item) => item.id === mapped?.itemId);
      const resolve = (action: "map" | "historical_unknown") => run(() => getRepository().resolveStockSource({ operationId: crypto.randomUUID(), sourceId: source.id, idempotencyKey: source.idempotencyKey, rawPayloadJson: source.rawPayloadJson!, action, ...(action === "map" ? { itemId: Number(itemId) } : {}), reason, confirmed }));
      return <div key={source.id} className="space-y-2 rounded border p-3">
        <p className="break-all">{source.idempotencyKey}</p>
        <details><summary>{t("sync.recovery_evidence")}</summary><pre className="whitespace-pre-wrap break-all text-xs">{source.rawPayloadJson}</pre></details>
        {mapped ? <><p>{t("sync.recovery_mapped", { id: mapped.itemId ?? "" })}</p><p>{mappedItem?.name}: {(mappedItem?.stockMilli ?? 0) / 1000}</p><button className={btnSecondary} disabled={blocked || !mappedItem} onClick={() => void run(() => reconcileMappedSource(getRepository(), getConnector(), { itemId: mappedItem!.id, expectedLocalStockMilli: mappedItem!.stockMilli, reason, confirmed }))}>{t("reconcile.keep_mine")}</button></> : !exceptionalStockSourceEligible(source) ? <p>{t("sync.review_required")}</p> : <div className="flex flex-wrap gap-2"><button className={btnSecondary} disabled={blocked || !itemId || source.rawPayloadJson === undefined} onClick={() => void resolve("map")}>{t("sync.recovery_map")}</button><button className={btnSecondary} disabled={blocked || source.rawPayloadJson === undefined} onClick={() => void resolve("historical_unknown")}>{t("sync.recovery_unknown")}</button></div>}
      </div>;
    })}
    {reviews.map((intent) => {
      const item = items.find((entry) => entry.id === intent.itemId);
      const deltaMilli = (intent.review?.subsequentDeltaMilli ?? 0) + (item ? item.stockMilli - (intent.review?.currentStockMilli ?? item.stockMilli) : 0);
      const shortageMilli = Math.max(0, -((intent.result?.stockUnits ?? 0) * 1000 + deltaMilli));
      return <div key={intent.operationId} className="space-y-2 rounded border p-3">
        <p className="font-semibold">{item?.name ?? intent.externalId}</p>
        <p className="break-all text-sm">{intent.operationId}</p>
        <p>{t("sync.recovery_quantities", { original: intent.stockUnits, captured: intent.capturedStockMilli / 1000, current: (item?.stockMilli ?? 0) / 1000, delta: deltaMilli / 1000, shortage: shortageMilli / 1000, result: intent.result?.stockUnits ?? "—" })}</p>
        <p className="text-sm">{t("sync.recovery_historical_shortage", { shortage: (intent.review?.shortageMilli ?? 0) / 1000 })}</p>
        <button className={btnSecondary} disabled={blocked || !item} onClick={() => void run(() => recoverStockShortage(getRepository(), getConnector(), { parentOperationId: intent.operationId, expectedLocalStockMilli: item!.stockMilli, reason, confirmed }))}>{t("sync.recovery_zero")}</button>
      </div>;
    })}
    {intents.length > 0 && <details><summary>{t("sync.recovery_history")}</summary><ul className="space-y-2">{intents.map((intent) => <li className="break-all text-sm" key={intent.operationId}>{intent.operationId} · {intent.parentOperationId ?? "—"} · {intent.status} · {intent.reason ?? "—"}<pre className="whitespace-pre-wrap break-all">{JSON.stringify({ request: { quantity: intent.stockUnits, revision: intent.revision, generation: intent.generation }, capturedStockMilli: intent.capturedStockMilli, sourceBoundary: intent.sourceBoundary, result: intent.result, review: intent.review }, null, 2)}</pre></li>)}</ul></details>}
    {history.length > 0 && <details><summary>{t("sync.recovery_history")}</summary><ul className="space-y-2">{history.map((entry) => <li key={entry.operationId} className="break-all text-sm">{entry.operationId} · {entry.action === "historical_unknown" ? t("sync.recovery_unknown") : t("sync.recovery_map")} · {entry.externalId ?? entry.itemId} · {entry.reason} · {entry.retiredBy ?? "—"}<pre className="whitespace-pre-wrap break-all">{entry.rawPayloadJson}</pre></li>)}</ul></details>}
  </section>;
}

/** Products that live only on MyTownCart: visible here, never edited or stock-synced by this app. */
function PlatformOnlySection({
  snapshot,
  pulling,
  note,
  onPull,
}: {
  snapshot: PlatformOnlySnapshot | null;
  pulling: boolean;
  note: string | null;
  onPull: (products: readonly PlatformProduct[]) => void;
}) {
  const items = snapshot?.items ?? [];
  const platformPage = usePagination(items);
  return (
    <section
      className="rounded border border-gray-200 bg-white p-4"
      data-testid="platform-only"
    >
      <h2 className="font-semibold">
        {t("platform.title")}
        {snapshot ? ` (${items.length})` : ""}
      </h2>
      <p className="mt-1 text-sm text-gray-600">{t("platform.intro")}</p>
      {items.length > 0 ? (
        <button
          type="button"
          className={`${btnPrimary} mt-2`}
          data-testid="platform-pull-all"
          disabled={pulling || !syncAvailable()}
          onClick={() => onPull(items)}
        >
          {pulling
            ? t("platform.pulling")
            : t("platform.pull_all", { count: items.length })}
        </button>
      ) : null}
      {note ? (
        <p
          className="mt-2 text-sm text-gray-700"
          data-testid="platform-pull-note"
        >
          {note}
        </p>
      ) : null}
      {snapshot === null ? (
        <p
          className="mt-2 text-sm text-gray-500"
          data-testid="platform-unknown"
        >
          {t("platform.unknown")}
        </p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500" data-testid="platform-none">
          {t("platform.none")}
        </p>
      ) : (
        <>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {platformPage.visible.map((p) => (
              <tr
                key={p.productId}
                className="border-t border-gray-100"
                data-testid={`platform-${p.productId}`}
              >
                <td className="py-1 font-medium">{p.name}</td>
                <td className="py-1 text-gray-600">{p.categoryName}</td>
                <td className="py-1 text-right">{formatPaise(p.pricePaise)}</td>
                <td className="py-1 pl-4 text-right text-gray-600">
                  {t("mtc.state_stock", { count: p.stockUnits })}
                </td>
                <td
                  className={`py-1 pl-4 text-right ${p.isActive ? "text-gray-700" : "text-amber-800"}`}
                >
                  {p.isActive ? t("platform.live") : t("platform.hidden")}
                </td>
                <td className="py-1 pl-4 text-right">
                  <button
                    type="button"
                    className={btnSecondary}
                    data-testid={`platform-pull-${p.productId}`}
                    disabled={pulling || !syncAvailable()}
                    onClick={() => onPull([p])}
                  >
                    {t("platform.pull")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination {...platformPage} label={t("page.platform")} />
        </>
      )}
      {snapshot ? (
        <p className="mt-2 text-xs text-gray-500">
          {t("platform.checked", {
            when: new Date(snapshot.at).toLocaleString(),
          })}
        </p>
      ) : null}
    </section>
  );
}

function valueText(kind: ReconcileKind, value: number | null): string {
  if (value === null) return "—";
  if (kind === "remote_inactive")
    return value > 0 ? t("common.yes") : t("common.no");
  if (kind === "price") return formatPaise(value);
  return String(value);
}
