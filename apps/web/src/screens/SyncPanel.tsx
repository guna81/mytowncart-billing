// SPDX-License-Identifier: Apache-2.0
/**
 * Overview tab (B5, roadmap §8.6): one status strip, a manual "Sync now", and the
 * "needs attention" reconcile list (per-row choices). Scheduling and options
 * live in SyncSettingsPanel; background timers live ONLY in lib/autoSync.ts.
 */
import {
  useCallback,
  useEffect,
  useMemo,
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
import type {
  Item,
  OutboxRow,
  ReconcileFix,
} from "@mytowncart-billing/storage";
import { t, type I18nKey } from "../i18n";
import { runAutoSync, SYNC_LAST_KEY } from "../lib/autoSync";
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
  listReconcileRows,
  syncAvailable,
  type SyncOutcome,
} from "../lib/syncEngine";
import { useAppStore } from "../store/appStore";

const btnPrimary =
  "rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300";
const btnSecondary =
  "rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50";

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
  const [last, setLast] = useState<LastSync | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReconcileRow[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [onlyOnMtc, setOnlyOnMtc] = useState<PlatformOnlySnapshot | null>(null);

  const refresh = useCallback(async () => {
    const repo = getRepository();
    setPending(await repo.listOutbox("pending"));
    setLast(await loadLastSync());
    setRows(await listReconcileRows(repo));
    setItems(await repo.listItems({ activeOnly: false }));
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
  const nameById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const settle = async (targets: readonly ReconcileRow[], pull: boolean) => {
    await getRepository().applyReconcileFixes(
      targets.map((row): ReconcileFix => {
        const item = nameById.get(row.itemId);
        if (pull && row.kind !== "missing_remote") {
          return {
            itemId: row.itemId,
            externalId: row.externalId,
            kind: row.kind,
            pullToLocal: true,
          };
        }
        return {
          itemId: row.itemId,
          externalId: row.externalId,
          kind: row.kind,
          pricePaise: item?.pricePaise,
          stockUnits:
            item === undefined
              ? undefined
              : Math.max(0, Math.trunc(item.stockMilli / 1000)),
          isActive: item?.isActive,
        };
      }),
    );
    bumpDataVersion();
    await refresh();
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
            {rows.length === 0 ? (
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
                    {rows.map((row) => (
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
                            onClick={() => void settle([row], false)}
                          >
                            {t("reconcile.keep_mine")}
                          </button>
                          {row.kind !== "missing_remote" ? (
                            <button
                              type="button"
                              className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50"
                              data-testid={`reconcile-use-${row.itemId}-${row.kind}`}
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
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={btnPrimary}
                    data-testid="reconcile-local"
                    onClick={() => void settle(rows, false)}
                  >
                    {t("reconcile.apply", { count: rows.length })}
                  </button>
                  {rows.some((r) => r.kind !== "missing_remote") ? (
                    <button
                      type="button"
                      className={btnSecondary}
                      data-testid="reconcile-pull"
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
        <table className="mt-3 w-full text-sm">
          <tbody>
            {items.map((p) => (
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
