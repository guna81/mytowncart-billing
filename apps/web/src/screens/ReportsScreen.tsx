// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import {
  aggregateDailySales,
  aggregateSalesByItem,
  aggregateSalesByPaymentMode,
  formatPaise,
  formatQty,
  isoDateOf,
  PAYMENT_MODES,
  serializeCsv,
  type ReportBill,
} from "@mytowncart-billing/core";
import { t } from "../i18n";
import { paymentModeLabel } from "../lib/labels";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Default range: the last 30 days, inclusive of today. */
function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  return { from: isoDateOf(start), to: isoDateOf(today) };
}

export function ReportsScreen() {
  const dataVersion = useAppStore((s) => s.dataVersion);
  const [range, setRange] = useState(defaultRange);
  const [bills, setBills] = useState<ReportBill[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const repo = getRepository();
      const summaries = await repo.listBills({
        from: `${range.from}T00:00:00`,
        to: `${range.to}T23:59:59.999`,
      });
      const details = await Promise.all(summaries.map((s) => repo.getBill(s.id)));
      if (cancelled) return;
      setBills(
        details.filter((d): d is NonNullable<typeof d> => d !== null).map((d) => ({
          id: d.id,
          number: d.number,
          status: d.status,
          createdAt: d.createdAt,
          subtotalPaise: d.subtotalPaise,
          taxPaise: d.taxPaise,
          totalPaise: d.totalPaise,
          lines: d.lines.map((l) => ({
            itemId: l.itemId,
            nameSnapshot: l.nameSnapshot,
            qtyMilli: l.qtyMilli,
            totalPaise: l.totalPaise,
            taxPaise: l.taxPaise,
          })),
          payments: d.payments.map((p) => ({ mode: p.mode, amountPaise: p.amountPaise })),
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [range, dataVersion]);

  const daily = aggregateDailySales(bills);
  const byItem = aggregateSalesByItem(bills);
  const byMode = aggregateSalesByPaymentMode(bills);
  const total = daily.reduce((s, r) => s + r.totalPaise, 0);
  const voided = bills.filter((b) => b.status === "void").length;

  /** One CSV per section, so each can be opened on its own in a spreadsheet. */
  const onExport = (section: "daily" | "item" | "mode") => {
    const header =
      section === "daily"
        ? ["date", "bills", "subtotal", "tax", "total"]
        : section === "item"
          ? ["item", "qty", "amount"]
          : ["payment_mode", "amount"];
    const body =
      section === "daily"
        ? daily.map((r) => [
            r.date,
            r.billCount,
            formatPaise(r.subtotalPaise),
            formatPaise(r.taxPaise),
            formatPaise(r.totalPaise),
          ])
        : section === "item"
          ? byItem.map((r) => [r.name, formatQty(r.qtyMilli), formatPaise(r.totalPaise)])
          : PAYMENT_MODES.map((mode) => [
              mode,
              formatPaise(byMode.find((r) => r.mode === mode)?.amountPaise ?? 0),
            ]);
    downloadText(`sales-${section}-${range.from}-to-${range.to}.csv`, serializeCsv([header, ...body]));
  };

  const exportButton = (section: "daily" | "item" | "mode", testId: string) => (
    <button
      type="button"
      data-testid={testId}
      className="rounded border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
      onClick={() => onExport(section)}
    >
      {t("reports.export_csv")}
    </button>
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-lg font-bold">{t("reports.title")}</h1>
        <div className="flex items-end gap-2">
          <label className="block text-sm">
            <span className="text-gray-600">{t("reports.from")}</span>
            <input
              type="date"
              className="mt-1 rounded border border-gray-300 px-3 py-1.5 text-sm"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">{t("reports.to")}</span>
            <input
              type="date"
              className="mt-1 rounded border border-gray-300 px-3 py-1.5 text-sm"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </label>
          <button
            type="button"
            data-testid="reports-export"
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={() => onExport("daily")}
          >
            {t("reports.export_csv")}
          </button>
        </div>
      </div>

      {daily.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="reports-empty">
          {bills.length === 0 ? t("reports.empty") : t("reports.empty_void_only")}
        </p>
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-gray-600" data-testid="reports-summary">
            {t("reports.bills")}:{" "}
            <span className="font-semibold">{daily.reduce((s, r) => s + r.billCount, 0)}</span>
            {voided > 0 ? <span className="text-gray-500"> (+{voided} {t("reports.voided")})</span> : null}
            {" · "}
            {t("common.total")}: <span className="font-semibold">₹{formatPaise(total)}</span>
          </p>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">{t("reports.daily")}</h2>
              {exportButton("daily", "reports-export-daily")}
            </div>
            <table className="w-full rounded border border-gray-200 bg-white text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="px-3 py-2">{t("reports.date")}</th>
                  <th className="px-3 py-2 text-right">{t("reports.bills")}</th>
                  <th className="px-3 py-2 text-right">{t("pos.tax")}</th>
                  <th className="px-3 py-2 text-right">{t("reports.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((r) => (
                  <tr key={r.date} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-2">{r.date}</td>
                    <td className="px-3 py-2 text-right">{r.billCount}</td>
                    <td className="px-3 py-2 text-right">{formatPaise(r.taxPaise)}</td>
                    <td className="px-3 py-2 text-right font-medium">
                      ₹{formatPaise(r.totalPaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">{t("reports.by_item")}</h2>
              {exportButton("item", "reports-export-item")}
            </div>
            <table className="w-full rounded border border-gray-200 bg-white text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="px-3 py-2">{t("print.item")}</th>
                  <th className="px-3 py-2 text-right">{t("reports.qty_sold")}</th>
                  <th className="px-3 py-2 text-right">{t("reports.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {byItem.map((r) => (
                  <tr key={`${r.itemId ?? r.name}`} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2 text-right">{formatQty(r.qtyMilli)}</td>
                    <td className="px-3 py-2 text-right">₹{formatPaise(r.totalPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">{t("reports.by_mode")}</h2>
              {exportButton("mode", "reports-export-mode")}
            </div>
            <table className="w-full rounded border border-gray-200 bg-white text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="px-3 py-2">{t("reports.mode")}</th>
                  <th className="px-3 py-2 text-right">{t("reports.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {byMode.map((r) => (
                  <tr key={r.mode} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-2">{paymentModeLabel(r.mode)}</td>
                    <td className="px-3 py-2 text-right">₹{formatPaise(r.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  );
}
