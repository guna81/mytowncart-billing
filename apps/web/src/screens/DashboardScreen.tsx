// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  formatPaise,
  formatQty,
  isLowStock,
  isoDateOf,
  roundDiv,
  PAYMENT_MODES,
  aggregateSalesByItem,
  aggregateSalesByPaymentMode,
  type ReportBill,
} from "@mytowncart-billing/core";
import { BACKUP_SETTINGS_KEY, parseBackupSettings } from "@mytowncart-billing/backup";
import type { Item } from "@mytowncart-billing/storage";
import { HourlyHeatmap } from "../components/charts/HourlyHeatmap";
import { PaymentModePieChart } from "../components/charts/PaymentModePieChart";
import { PageHeader } from "../components/ui";
import { t, type I18nKey } from "../i18n";
import { getRepository } from "../lib/repository";
import { effectiveLowStockThreshold } from "../lib/stockAlerts";
import { useAppStore } from "../store/appStore";

export function DashboardScreen() {
  const profile = useAppStore((s) => s.profile);
  const [loading, setLoading] = useState(true);
  const [bills, setBills] = useState<ReportBill[]>([]);
  const [lowStockItems, setLowStockItems] = useState<Item[]>([]);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const repo = getRepository();
      const today = isoDateOf(new Date());

      const [reportBills, allItems, backupRaw] = await Promise.all([
        repo.getBillsReportData({ from: `${today}T00:00:00`, to: `${today}T23:59:59.999` }),
        repo.listItems({ activeOnly: true }),
        repo.getAppSetting(BACKUP_SETTINGS_KEY),
      ]);

      if (!cancelled) {
        setBills(reportBills);
        const threshold = effectiveLowStockThreshold(profile);
        setLowStockItems(threshold === 0 ? [] : allItems.filter((i) => isLowStock(i.stockMilli, threshold)));
        const backupSettings = parseBackupSettings(backupRaw);
        setLastBackupAt(backupSettings?.lastSuccessAt ?? null);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [profile?.lowStockThresholdMilli]);

  const activeBills = bills.filter((b) => b.status === "active");
  const totalSalesPaise = activeBills.reduce((s, b) => s + b.totalPaise, 0);
  const billCount = activeBills.length;
  const avgBillPaise = billCount > 0 ? roundDiv(totalSalesPaise, billCount) : 0;

  // Credit due today
  const creditDuePaise = activeBills.reduce((s, b) => {
    const credit = b.payments
      .filter((p) => p.mode === "credit")
      .reduce((m, p) => m + p.amountPaise, 0);
    return s + credit;
  }, 0);

  // Payment mode breakdown
  const aggregatedModes = aggregateSalesByPaymentMode(bills);
  const paymentBreakdown = PAYMENT_MODES.map((mode) => {
    const found = aggregatedModes.find((r) => r.mode === mode);
    return { mode, amountPaise: found?.amountPaise ?? 0 };
  });

  // Hourly sales buckets
  const hourlyBuckets = Array.from({ length: 24 }, (_, hour) => {
    const matching = activeBills.filter((b) => {
      const d = new Date(b.createdAt);
      return d.getHours() === hour;
    });
    return {
      hour,
      totalPaise: matching.reduce((s, b) => s + b.totalPaise, 0),
      count: matching.length,
    };
  });

  // Top selling items today
  const topItems = aggregateSalesByItem(bills).slice(0, 5);

  // Backup health
  const backupDays = lastBackupAt
    ? Math.floor((Date.now() - Date.parse(lastBackupAt)) / (1000 * 60 * 60 * 24))
    : null;
  const backupStatus =
    backupDays === null
      ? "never"
      : backupDays > 7
        ? "overdue"
        : backupDays > 3
          ? "due"
          : "healthy";

  if (loading) {
    return <div className="py-12 text-center text-sm text-gray-500">{t("common.loading")}</div>;
  }

  return (
    <div className="space-y-6" data-testid="dashboard-screen">
      {/* Top Header & Shortcuts */}
      <PageHeader
        title={t("dashboard.title")}
        subtitle={`${profile?.name ? `${profile.name} · ` : ""}${new Date().toLocaleDateString(undefined, { dateStyle: "full" })}`}
        actions={
          <>
            <Link
              to="/"
              className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-blue-700 transition-colors"
            >
              + {t("dashboard.quick_sale")}
            </Link>
            <Link
              to="/items"
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors shadow-2xs"
            >
              {t("dashboard.quick_items")}
            </Link>
            <Link
              to="/reports"
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors shadow-2xs"
            >
              {t("dashboard.quick_reports")}
            </Link>
          </>
        }
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm" data-testid="dashboard-today-sales">
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
            {t("dashboard.today_sales")}
          </p>
          <p className="mt-2 text-2xl font-bold text-blue-700">₹{formatPaise(totalSalesPaise)}</p>
          <p className="mt-1 text-xs text-gray-600">Net revenue today</p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm" data-testid="dashboard-today-bills">
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
            {t("dashboard.today_bills")}
          </p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{billCount}</p>
          <p className="mt-1 text-xs text-gray-600">Total completed orders</p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm" data-testid="dashboard-average-bill">
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
            {t("dashboard.average_bill")}
          </p>
          <p className="mt-2 text-2xl font-bold text-gray-900">₹{formatPaise(avgBillPaise)}</p>
          <p className="mt-1 text-xs text-gray-600">Average ticket size</p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm" data-testid="dashboard-today-credit">
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
            {t("dashboard.today_credit")}
          </p>
          <p className={`mt-2 text-2xl font-bold ${creditDuePaise > 0 ? "text-amber-600" : "text-gray-900"}`}>
            ₹{formatPaise(creditDuePaise)}
          </p>
          <p className="mt-1 text-xs text-gray-600">Outstanding credit issued</p>
        </div>
      </div>

      {/* Middle Row: Payment Breakdown & Top Items */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Payment Breakdown */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm" data-testid="dashboard-payment-breakdown">
          <h2 className="text-sm font-bold text-gray-800 mb-3">{t("dashboard.payment_breakdown")}</h2>
          <div className="mb-4">
            <PaymentModePieChart slices={paymentBreakdown} size={150} />
          </div>
          <div className="space-y-3">
            {paymentBreakdown.map(({ mode, amountPaise }) => {
              const pct = totalSalesPaise > 0 ? Math.round((amountPaise * 100) / totalSalesPaise) : 0;
              return (
                <div key={mode}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium text-gray-700">{t(`pos.mode.${mode}` as I18nKey)}</span>
                    <span className="font-mono text-gray-900">
                      ₹{formatPaise(amountPaise)} ({pct}%)
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className={`h-full ${
                        mode === "cash"
                          ? "bg-green-500"
                          : mode === "upi"
                            ? "bg-blue-500"
                            : mode === "card"
                              ? "bg-indigo-500"
                              : "bg-amber-500"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Top Selling Items */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm" data-testid="dashboard-top-items">
          <h2 className="text-sm font-bold text-gray-800 mb-3">{t("dashboard.top_items")}</h2>
          {topItems.length === 0 ? (
            <p className="py-6 text-center text-xs text-gray-600">{t("dashboard.top_items_empty")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-gray-600 font-semibold">
                  <th className="pb-2 text-left font-medium">{t("print.item")}</th>
                  <th className="pb-2 text-right font-medium">{t("reports.qty_sold")}</th>
                  <th className="pb-2 text-right font-medium">{t("reports.amount")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {topItems.map((item, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="py-2 font-medium text-gray-800">{item.name}</td>
                    <td className="py-2 text-right text-gray-600">{formatQty(item.qtyMilli)}</td>
                    <td className="py-2 text-right font-mono font-medium text-gray-900">
                      ₹{formatPaise(item.totalPaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Hourly Sales Activity */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm" data-testid="dashboard-hourly-activity">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-bold text-gray-800">Hourly Store Traffic & Sales Velocity</h2>
          <span className="text-xs text-gray-600 font-mono">00:00 - 23:59</span>
        </div>
        <HourlyHeatmap buckets={hourlyBuckets} height={120} />
      </div>

      {/* Bottom Row: Low Stock Alerts & Backup Health */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Low Stock Alerts */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm" data-testid="dashboard-low-stock">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-gray-800">{t("dashboard.low_stock")}</h2>
            <Link to="/stock" className="text-xs text-blue-600 hover:underline">
              {t("common.actions")} →
            </Link>
          </div>
          {effectiveLowStockThreshold(profile) === 0 ? (
            <p className="py-6 text-center text-xs text-gray-600 bg-gray-50 rounded">
              {t("dashboard.low_stock_off")} ·{" "}
              <Link to="/settings" className="text-blue-600 underline font-semibold">
                {t("nav.settings")}
              </Link>
            </p>
          ) : lowStockItems.length === 0 ? (
            <p className="py-6 text-center text-xs text-green-700 bg-green-50 rounded">
              ✓ {t("dashboard.low_stock_none")}
            </p>
          ) : (
            <div className="max-h-48 overflow-y-auto divide-y divide-gray-100 text-xs">
              {lowStockItems.map((item) => (
                <div key={item.id} className="py-2 flex items-center justify-between">
                  <div>
                    <p className="font-medium text-gray-800">{item.name}</p>
                    <p className="text-gray-600 font-mono text-xs">{item.barcode || "—"}</p>
                  </div>
                  <span className="rounded bg-red-50 px-2 py-0.5 font-bold text-red-600">
                    {formatQty(item.stockMilli)} left
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Backup Health */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm" data-testid="dashboard-backup-status">
          <h2 className="text-sm font-bold text-gray-800 mb-3">{t("dashboard.backup_status")}</h2>
          <div className="flex items-center gap-3">
            <div
              className={`h-4 w-4 rounded-full ${
                backupStatus === "healthy"
                  ? "bg-green-500"
                  : backupStatus === "due"
                    ? "bg-amber-500"
                    : "bg-red-500"
              }`}
            />
            <div>
              <p className="text-sm font-semibold text-gray-900">
                {backupStatus === "healthy"
                  ? t("dashboard.backup_healthy")
                  : backupStatus === "due"
                    ? t("dashboard.backup_due")
                    : backupStatus === "overdue"
                      ? t("dashboard.backup_overdue")
                      : t("dashboard.backup_never")}
              </p>
              <p className="text-xs text-gray-500">
                {lastBackupAt
                  ? t("backup.last", { when: new Date(lastBackupAt).toLocaleString() })
                  : t("backup.never")}
              </p>
            </div>
          </div>
          <div className="mt-4">
            <Link
              to="/settings"
              className="inline-block rounded border border-gray-300 bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100"
            >
              {t("dashboard.backup_now")} →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
