// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import {
  aggregateDailySales,
  aggregateSalesByItem,
  aggregateSalesByPaymentMode,
  formatPaise,
  formatQty,
  generateGstr1Dataset,
  isoDateOf,
  PAYMENT_MODES,
  serializeCsv,
  serializeGstr1Csvs,
  type ReportBill,
} from "@mytowncart-billing/core";
import type { CreditNote, Customer, Item } from "@mytowncart-billing/storage";
import { SalesTrendChart } from "../components/charts/SalesTrendChart";
import { t, type I18nKey } from "../i18n";
import { paymentModeLabel } from "../lib/labels";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
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

type RangePreset = "today" | "yesterday" | "this_week" | "this_month" | "this_fy" | "last_30_days";

function getPresetRange(preset: RangePreset): { from: string; to: string } {
  const today = new Date();
  const todayIso = isoDateOf(today);

  switch (preset) {
    case "today":
      return { from: todayIso, to: todayIso };
    case "yesterday": {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      const yIso = isoDateOf(y);
      return { from: yIso, to: yIso };
    }
    case "this_week": {
      const d = new Date(today);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const mon = new Date(d.setDate(diff));
      return { from: isoDateOf(mon), to: todayIso };
    }
    case "this_month": {
      const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: isoDateOf(firstOfMonth), to: todayIso };
    }
    case "this_fy": {
      const curYear = today.getFullYear();
      const startYear = today.getMonth() >= 3 ? curYear : curYear - 1;
      const fyStart = new Date(startYear, 3, 1);
      return { from: isoDateOf(fyStart), to: todayIso };
    }
    case "last_30_days":
    default:
      return defaultRange();
  }
}

interface ItemProfitRow {
  key: string;
  name: string;
  qtyMilli: number;
  revenuePaise: number;
  unitCostPaise: number;
  cogsPaise: number;
  grossProfitPaise: number;
  marginPct: number;
}

export function ReportsScreen() {
  const profile = useAppStore((s) => s.profile);
  const dataVersion = useAppStore((s) => s.dataVersion);
  const [range, setRange] = useState(defaultRange);
  const [bills, setBills] = useState<ReportBill[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const repo = getRepository();
      const [reportBills, itemList, customerList, cnList] = await Promise.all([
        repo.getBillsReportData({
          from: `${range.from}T00:00:00`,
          to: `${range.to}T23:59:59.999`,
        }),
        repo.listItems(),
        repo.listCustomers(),
        repo.listCreditNotes(),
      ]);
      if (!cancelled) {
        setBills(reportBills);
        setItems(itemList);
        setCustomers(customerList);
        setCreditNotes(cnList);
        setLoading(false);
      }
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

  // Compute profit and margins
  const itemMap = new Map<number, Item>(items.map((i) => [i.id, i]));
  const profitMap = new Map<string, ItemProfitRow>();

  for (const b of bills) {
    if (b.status !== "active") continue;
    for (const l of b.lines) {
      const key = l.itemId !== null ? String(l.itemId) : l.nameSnapshot;
      const item = l.itemId !== null ? itemMap.get(l.itemId) : undefined;
      const unitCost = item?.costPricePaise ?? 0;
      const cogs = Math.round((l.qtyMilli * unitCost) / 1000);
      const netRevenue = l.totalPaise - l.taxPaise;

      const existing = profitMap.get(key);
      if (existing) {
        existing.qtyMilli += l.qtyMilli;
        existing.revenuePaise += netRevenue;
        existing.cogsPaise += cogs;
        existing.grossProfitPaise = existing.revenuePaise - existing.cogsPaise;
        existing.marginPct =
          existing.revenuePaise > 0
            ? Math.round((existing.grossProfitPaise / existing.revenuePaise) * 1000) / 10
            : 0;
      } else {
        const grossProfit = netRevenue - cogs;
        profitMap.set(key, {
          key,
          name: l.nameSnapshot,
          qtyMilli: l.qtyMilli,
          revenuePaise: netRevenue,
          unitCostPaise: unitCost,
          cogsPaise: cogs,
          grossProfitPaise: grossProfit,
          marginPct:
            netRevenue > 0 ? Math.round((grossProfit / netRevenue) * 1000) / 10 : 0,
        });
      }
    }
  }

  const profitRows = Array.from(profitMap.values()).sort(
    (a, b) => b.grossProfitPaise - a.grossProfitPaise
  );
  const totalRevenuePaise = profitRows.reduce((acc, r) => acc + r.revenuePaise, 0);
  const totalCogsPaise = profitRows.reduce((acc, r) => acc + r.cogsPaise, 0);
  const totalGrossProfitPaise = totalRevenuePaise - totalCogsPaise;
  const overallMarginPct =
    totalRevenuePaise > 0
      ? Math.round((totalGrossProfitPaise / totalRevenuePaise) * 1000) / 10
      : 0;

  // GSTR-1 tax return dataset
  const customersMap = new Map(
    customers
      .filter((c) => Boolean(c.gstin))
      .map((c) => [
        c.id,
        {
          name: c.name,
          gstin: c.gstin!,
          stateCode: c.gstin!.slice(0, 2),
        },
      ]),
  );

  const billMap = new Map(bills.map((b) => [b.id, b.number]));
  const cdnrRecords = creditNotes
    .filter(
      (cn) =>
        cn.createdAt >= `${range.from}T00:00:00` &&
        cn.createdAt <= `${range.to}T23:59:59.999`,
    )
    .map((cn) => ({
      number: cn.number,
      billNumber: billMap.get(cn.billId) || `INV-${cn.billId}`,
      createdAt: cn.createdAt,
      subtotalPaise: cn.subtotalPaise,
      taxPaise: cn.taxPaise,
      totalPaise: cn.totalPaise,
      reason: cn.reason,
    }));

  const shopStateCode = profile?.gstin ? profile.gstin.slice(0, 2) : "33";
  const gstr1Data = generateGstr1Dataset(bills, customersMap, cdnrRecords, shopStateCode);
  const gstr1Csvs = serializeGstr1Csvs(gstr1Data);

  const downloadGstr1 = (table: "b2b" | "b2cs" | "cdnr" | "hsn") => {
    const filename = `GSTR1_${table.toUpperCase()}_${range.from}_to_${range.to}.csv`;
    const csvContent =
      table === "b2b"
        ? gstr1Csvs.b2bCsv
        : table === "b2cs"
        ? gstr1Csvs.b2csCsv
        : table === "cdnr"
        ? gstr1Csvs.cdnrCsv
        : gstr1Csvs.hsnCsv;
    downloadText(filename, csvContent);
  };

  /** One CSV per section, so each can be opened on its own in a spreadsheet. */
  const onExport = (section: "daily" | "item" | "mode" | "profit") => {
    let header: string[];
    let body: (string | number)[][];

    if (section === "daily") {
      header = ["date", "bills", "subtotal", "tax", "total"];
      body = daily.map((r) => [
        r.date,
        r.billCount,
        formatPaise(r.subtotalPaise),
        formatPaise(r.taxPaise),
        formatPaise(r.totalPaise),
      ]);
    } else if (section === "item") {
      header = ["item", "qty", "amount"];
      body = byItem.map((r) => [r.name, formatQty(r.qtyMilli), formatPaise(r.totalPaise)]);
    } else if (section === "mode") {
      header = ["payment_mode", "amount"];
      body = PAYMENT_MODES.map((mode) => [
        mode,
        formatPaise(byMode.find((r) => r.mode === mode)?.amountPaise ?? 0),
      ]);
    } else {
      header = ["item", "qty_sold", "revenue", "cogs", "gross_profit", "margin_pct"];
      body = profitRows.map((r) => [
        r.name,
        formatQty(r.qtyMilli),
        formatPaise(r.revenuePaise),
        formatPaise(r.cogsPaise),
        formatPaise(r.grossProfitPaise),
        `${r.marginPct}%`,
      ]);
    }
    downloadText(`sales-${section}-${range.from}-to-${range.to}.csv`, serializeCsv([header, ...body]));
  };

  const exportButton = (section: "daily" | "item" | "mode" | "profit", testId: string) => (
    <button
      type="button"
      data-testid={testId}
      className="rounded border border-gray-300 bg-white px-2.5 py-1 text-xs hover:bg-gray-50"
      onClick={() => onExport(section)}
    >
      {t("reports.export_csv")}
    </button>
  );

  const presets: { id: RangePreset; labelKey: string }[] = [
    { id: "today", labelKey: "reports.range.today" },
    { id: "yesterday", labelKey: "reports.range.yesterday" },
    { id: "this_week", labelKey: "reports.range.this_week" },
    { id: "this_month", labelKey: "reports.range.this_month" },
    { id: "this_fy", labelKey: "reports.range.this_fy" },
    { id: "last_30_days", labelKey: "reports.range.last_30_days" },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold">{t("reports.title")}</h1>
          <div className="mt-2 flex flex-wrap gap-1">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                data-testid={`reports-preset-${p.id}`}
                className="rounded border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
                onClick={() => setRange(getPresetRange(p.id))}
              >
                {t(p.labelKey as I18nKey)}
              </button>
            ))}
          </div>
        </div>

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

      {loading ? (
        <p className="py-8 text-center text-sm text-gray-500">{t("common.loading")}</p>
      ) : daily.length === 0 ? (
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

          {/* Visual Sales Trend Curve */}
          <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-xs" data-testid="reports-trend-section">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="font-bold text-base text-gray-900">Revenue Trend (Daily)</h2>
                <p className="text-xs text-gray-500">Sales curve across selected period</p>
              </div>
              <span className="font-mono text-xs font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">
                ₹{formatPaise(total)} total
              </span>
            </div>
            <SalesTrendChart
              points={daily.map((d) => ({
                date: d.date,
                totalPaise: d.totalPaise,
                count: d.billCount,
              }))}
              height={160}
            />
          </section>

          {/* Profit & Margins Section */}
          <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-xs" data-testid="reports-profit-section">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-bold text-base text-gray-900">{t("reports.profit_margin")}</h2>
                <p className="text-xs text-gray-500">Based on cost price recorded on items</p>
              </div>
              {exportButton("profit", "reports-export-profit")}
            </div>

            {/* KPI Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <div className="p-3 bg-gray-50 rounded-lg border border-gray-100">
                <p className="text-xs text-gray-500 font-medium">Net Revenue</p>
                <p className="text-lg font-bold text-gray-900">₹{formatPaise(totalRevenuePaise)}</p>
              </div>
              <div className="p-3 bg-amber-50/50 rounded-lg border border-amber-100">
                <p className="text-xs text-amber-700 font-medium">{t("reports.cogs")}</p>
                <p className="text-lg font-bold text-amber-900">₹{formatPaise(totalCogsPaise)}</p>
              </div>
              <div className="p-3 bg-green-50 rounded-lg border border-green-100">
                <p className="text-xs text-green-700 font-medium">{t("reports.gross_profit")}</p>
                <p className="text-lg font-bold text-green-800" data-testid="reports-gross-profit">
                  ₹{formatPaise(totalGrossProfitPaise)}
                </p>
              </div>
              <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
                <p className="text-xs text-blue-700 font-medium">{t("reports.margin_pct")}</p>
                <p className="text-lg font-bold text-blue-800" data-testid="reports-margin-pct">
                  {overallMarginPct}%
                </p>
              </div>
            </div>

            {/* Item Breakdown Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid="reports-profit-table">
                <thead>
                  <tr className="border-b border-gray-200 text-xs font-semibold text-gray-500">
                    <th className="py-2 px-3">{t("print.item")}</th>
                    <th className="py-2 px-3 text-right">{t("reports.qty_sold")}</th>
                    <th className="py-2 px-3 text-right">Revenue</th>
                    <th className="py-2 px-3 text-right">{t("purchases.cost_price")}</th>
                    <th className="py-2 px-3 text-right">{t("reports.cogs")}</th>
                    <th className="py-2 px-3 text-right">{t("reports.gross_profit")}</th>
                    <th className="py-2 px-3 text-right">{t("reports.margin_pct")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-xs">
                  {profitRows.map((r) => (
                    <tr key={r.key} className="hover:bg-gray-50/50">
                      <td className="py-2.5 px-3 font-medium text-gray-800">{r.name}</td>
                      <td className="py-2.5 px-3 text-right text-gray-600">{formatQty(r.qtyMilli)}</td>
                      <td className="py-2.5 px-3 text-right font-medium text-gray-700">₹{formatPaise(r.revenuePaise)}</td>
                      <td className="py-2.5 px-3 text-right text-gray-500">₹{formatPaise(r.unitCostPaise)}</td>
                      <td className="py-2.5 px-3 text-right text-amber-700">₹{formatPaise(r.cogsPaise)}</td>
                      <td className="py-2.5 px-3 text-right font-semibold text-green-700">₹{formatPaise(r.grossProfitPaise)}</td>
                      <td className="py-2.5 px-3 text-right font-semibold text-blue-700">{r.marginPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

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

          {/* GSTR-1 Tax Filing Export Section */}
          <section className="rounded-lg border border-purple-200 bg-purple-50/40 p-4 shadow-xs" data-testid="reports-gstr1-section">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-bold text-base text-purple-900">GSTR-1 Tax Return Exports</h2>
                <p className="text-xs text-purple-700">
                  Govt GST Offline Tool compliant CSV tables for period {range.from} to {range.to}
                </p>
              </div>
              <span className="text-xs font-mono font-medium text-purple-800 bg-purple-100 px-2 py-0.5 rounded">
                State POS: {shopStateCode}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {/* Table 4A: B2B */}
              <div className="rounded-lg border border-purple-200 bg-white p-3 flex flex-col justify-between">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-purple-600 block">
                    Table 4A
                  </span>
                  <span className="font-semibold text-xs text-gray-900 block mt-0.5">B2B Invoices</span>
                  <p className="text-[11px] text-gray-500 mt-1">
                    {gstr1Data.b2bRows.length} supplies with GSTIN
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="gstr1-b2b-btn"
                  className="mt-3 rounded border border-purple-300 bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-800 hover:bg-purple-100"
                  onClick={() => downloadGstr1("b2b")}
                >
                  Download CSV
                </button>
              </div>

              {/* Table 7: B2C Small */}
              <div className="rounded-lg border border-purple-200 bg-white p-3 flex flex-col justify-between">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-purple-600 block">
                    Table 7 / 5
                  </span>
                  <span className="font-semibold text-xs text-gray-900 block mt-0.5">B2C Small</span>
                  <p className="text-[11px] text-gray-500 mt-1">
                    {gstr1Data.b2csRows.length} rate groups
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="gstr1-b2cs-btn"
                  className="mt-3 rounded border border-purple-300 bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-800 hover:bg-purple-100"
                  onClick={() => downloadGstr1("b2cs")}
                >
                  Download CSV
                </button>
              </div>

              {/* Table 9B: CDNR */}
              <div className="rounded-lg border border-purple-200 bg-white p-3 flex flex-col justify-between">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-purple-600 block">
                    Table 9B
                  </span>
                  <span className="font-semibold text-xs text-gray-900 block mt-0.5">Credit / Debit Notes</span>
                  <p className="text-[11px] text-gray-500 mt-1">
                    {gstr1Data.cdnrRows.length} credit notes
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="gstr1-cdnr-btn"
                  className="mt-3 rounded border border-purple-300 bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-800 hover:bg-purple-100"
                  onClick={() => downloadGstr1("cdnr")}
                >
                  Download CSV
                </button>
              </div>

              {/* Table 12: HSN Summary */}
              <div className="rounded-lg border border-purple-200 bg-white p-3 flex flex-col justify-between">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-purple-600 block">
                    Table 12
                  </span>
                  <span className="font-semibold text-xs text-gray-900 block mt-0.5">HSN Summary</span>
                  <p className="text-[11px] text-gray-500 mt-1">
                    {gstr1Data.hsnRows.length} HSN tariff codes
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="gstr1-hsn-btn"
                  className="mt-3 rounded border border-purple-300 bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-800 hover:bg-purple-100"
                  onClick={() => downloadGstr1("hsn")}
                >
                  Download CSV
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
