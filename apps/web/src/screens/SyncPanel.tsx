// SPDX-License-Identifier: Apache-2.0
/**
 * Sync tab (B5, roadmap §8.6): outbox status, a manual "Sync now", the
 * reconcile list, and the read-only online orders list.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  formatPaise,
  localIsoTimestamp,
  type ReconcileKind,
  type ReconcileRow,
} from "@mytowncart-billing/core";
import type { Item, OutboxRow, ReconcileFix, RemoteOrderRecord } from "@mytowncart-billing/storage";
import { t, type I18nKey } from "../i18n";
import { getConnector } from "../lib/marketplace";
import { getRepository } from "../lib/repository";
import { listReconcileRows, runSync, syncAvailable, type SyncOutcome } from "../lib/syncEngine";
import { useAppStore } from "../store/appStore";

const btnPrimary =
  "rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300";
const btnSecondary = "rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50";

const SYNC_SETTINGS_KEY = "sync.last";
const AUTO_SYNC_MS = 5 * 60_000;

interface LastSync {
  at: string;
  outcome: SyncOutcome;
}

async function loadLastSync(): Promise<LastSync | null> {
  const raw = await getRepository().getAppSetting(SYNC_SETTINGS_KEY);
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

export function SyncPanel() {
  const dataVersion = useAppStore((s) => s.dataVersion);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);
  const [pending, setPending] = useState<OutboxRow[]>([]);
  const [last, setLast] = useState<LastSync | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReconcileRow[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const refresh = useCallback(async () => {
    const repo = getRepository();
    setPending(await repo.listOutbox("pending"));
    setLast(await loadLastSync());
    setRows(await listReconcileRows(repo));
    setItems(await repo.listItems({ activeOnly: false }));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, dataVersion]);

  const syncNow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const repo = getRepository();
      const outcome = await runSync({
        repo,
        connector: getConnector(),
        now: () => new Date(),
        isApproved: () => true,
      });
      const record: LastSync = { at: outcome.at, outcome };
      await repo.setAppSetting(SYNC_SETTINGS_KEY, JSON.stringify(record));
      setLast(record);
      bumpDataVersion();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [bumpDataVersion, refresh]);

  // Automatic sync while connected; the tab only schedule-ticks the desktop app.
  useEffect(() => {
    if (!syncAvailable()) return;
    const timer = setInterval(() => void syncNow(), AUTO_SYNC_MS);
    return () => clearInterval(timer);
  }, [syncNow]);

  const dueCount = pending.filter(
    (p) => p.nextAttemptAt === null || p.nextAttemptAt <= localIsoTimestamp(new Date()),
  ).length;
  const nameById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const settle = async (pullAll: boolean) => {
    await getRepository().applyReconcileFixes(
      rows.map((row): ReconcileFix => {
        const item = nameById.get(row.itemId);
        if (pullAll && row.kind !== "missing_remote") {
          return { itemId: row.itemId, externalId: row.externalId, kind: row.kind, pullToLocal: true };
        }
        return {
          itemId: row.itemId,
          externalId: row.externalId,
          kind: row.kind,
          pricePaise: item?.pricePaise,
          stockUnits: item === undefined ? undefined : Math.max(0, Math.trunc(item.stockMilli / 1000)),
          isActive: item?.isActive,
        };
      }),
    );
    bumpDataVersion();
    await refresh();
  };

  return (
    <div className="space-y-4" data-testid="sync-panel">
      <section className="rounded border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">{t("sync.title")}</h2>
            <p className="mt-1 text-sm text-gray-600">{t("sync.intro")}</p>
          </div>
          <button
            type="button"
            className={btnPrimary}
            data-testid="sync-now"
            disabled={busy || !syncAvailable()}
            onClick={() => void syncNow()}
          >
            {busy ? t("sync.syncing") : t("sync.now")}
          </button>
        </div>
        {!syncAvailable() ? (
          <p className="mt-2 text-sm text-gray-500" data-testid="sync-desktop-only">
            {t("sync.desktop_only")}
          </p>
        ) : (
          <p className="mt-2 text-xs text-gray-500">{t("sync.auto")}</p>
        )}

        <p className="mt-3 text-sm text-gray-700" data-testid="sync-last">
          {last ? t("sync.last", { when: new Date(last.at).toLocaleString() }) : t("sync.never")}
        </p>
        <p className="text-sm text-gray-700" data-testid="sync-pending">
          {pending.length === 0
            ? t("sync.pending_none")
            : dueCount > 0
              ? t("sync.pending", { count: pending.length })
              : t("sync.pending_retry", { count: pending.length })}
        </p>

        {last ? (
          <p className="mt-2 text-sm text-gray-600" data-testid="sync-summary">
            {t("sync.done_shipped", {
              moves: last.outcome.pushedMoves,
              pulled: last.outcome.pulledMoves,
              restocked: last.outcome.restocked,
            })}
            {" · "}
            {t("sync.done_orders", { count: last.outcome.orders })}
          </p>
        ) : null}
        {last && last.outcome.problems.length > 0 ? (
          <div className="mt-2 rounded bg-amber-50 p-2" data-testid="sync-problems">
            <p className="text-sm text-amber-900">{t("sync.problems")}</p>
            <ul className="mt-1 list-disc pl-5 text-xs text-amber-900">
              {last.outcome.problems.slice(0, 8).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {error ? (
          <p className="mt-2 text-sm text-red-600" data-testid="sync-error">{error}</p>
        ) : null}
      </section>

      <section className="rounded border border-gray-200 bg-white p-4" data-testid="reconcile">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{t("reconcile.title")}</h2>
          <button type="button" className={btnSecondary} onClick={() => void refresh()}>
            {t("reconcile.refresh")}
          </button>
        </div>
        <p className="mt-1 text-sm text-gray-600">{t("reconcile.intro")}</p>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500" data-testid="reconcile-none">
            {t("reconcile.none")}
          </p>
        ) : (
          <>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="py-1">{t("reconcile.item")}</th>
                  <th className="py-1">{t("reconcile.kind")}</th>
                  <th className="py-1 text-right">{t("reconcile.local")}</th>
                  <th className="py-1 text-right">{t("reconcile.remote")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.itemId}:${row.kind}`} className="border-t border-gray-100" data-testid={`reconcile-${row.itemId}-${row.kind}`}>
                    <td className="py-1 font-medium">{row.name}</td>
                    <td className="py-1">{t(`reconcile.kind.${row.kind}` as I18nKey)}</td>
                    <td className="py-1 text-right">{valueText(row.kind, row.localValue)}</td>
                    <td className="py-1 text-right">{valueText(row.kind, row.remoteValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className={btnPrimary}
                data-testid="reconcile-local"
                onClick={() => void settle(false)}
              >
                {t("reconcile.apply", { count: rows.length })}
              </button>
              {rows.some((r) => r.kind !== "missing_remote") ? (
                <button
                  type="button"
                  className={btnSecondary}
                  data-testid="reconcile-pull"
                  onClick={() => void settle(true)}
                >
                  {t("reconcile.pull")}
                </button>
              ) : null}
            </div>
          </>
        )}
      </section>

      <OnlineOrders />
    </div>
  );
}

function valueText(kind: ReconcileKind, value: number | null): string {
  if (value === null) return "—";
  if (kind === "remote_inactive") return value > 0 ? t("common.yes") : t("common.no");
  if (kind === "price") return formatPaise(value);
  return String(value);
}

function OnlineOrders() {
  const dataVersion = useAppStore((s) => s.dataVersion);
  const [orders, setOrders] = useState<RemoteOrderRecord[]>([]);

  useEffect(() => {
    void getRepository().listRemoteOrders().then(setOrders);
  }, [dataVersion]);

  return (
    <section className="rounded border border-gray-200 bg-white p-4" data-testid="online-orders">
      <h2 className="font-semibold">{t("orders.title")}</h2>
      <p className="mt-1 text-sm text-gray-600">{t("orders.intro")}</p>
      {orders.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500" data-testid="orders-none">
          {t("orders.none")}
        </p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-gray-500">
              <th className="py-1">{t("orders.date")}</th>
              <th className="py-1">{t("orders.number")}</th>
              <th className="py-1">{t("orders.status")}</th>
              <th className="py-1">{t("orders.payment")}</th>
              <th className="py-1">{t("orders.lines")}</th>
              <th className="py-1 text-right">{t("orders.total")}</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id} className="border-t border-gray-100" data-testid={`order-${order.id}`}>
                <td className="py-1 whitespace-nowrap">{new Date(order.placedAt).toLocaleDateString()}</td>
                <td className="py-1 font-mono text-xs">{order.id.slice(0, 8)}</td>
                <td className="py-1">{order.status}</td>
                <td className="py-1">{order.paymentStatus} · {order.paymentMethod}</td>
                <td className="py-1 text-xs text-gray-600">
                  {order.lines
                    .map((l) => `${l.productName ?? t("orders.service")} ×${l.qtyUnits}`)
                    .join(", ")}
                </td>
                <td className="py-1 text-right">{formatPaise(order.totalPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
