// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import {
  computeCashVariance,
  computeDenominationsTotalPaise,
  computeExpectedDrawerCash,
  formatPaise,
  parsePaise,
  type DenominationCounts,
} from "@mytowncart-billing/core";
import type { DayEndClosure, DayEndExpectedCash } from "@mytowncart-billing/storage";
import { Button } from "../components/ui";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

interface DenomDef {
  key: keyof DenominationCounts;
  val: number;
  label: string;
  isCoin?: boolean;
}

const DENOMS: DenomDef[] = [
  { key: "n2000", val: 2000, label: "₹2000" },
  { key: "n500", val: 500, label: "₹500" },
  { key: "n200", val: 200, label: "₹200" },
  { key: "n100", val: 100, label: "₹100" },
  { key: "n50", val: 50, label: "₹50" },
  { key: "n20", val: 20, label: "₹20" },
  { key: "n10", val: 10, label: "₹10" },
  { key: "n5", val: 5, label: "₹5" },
  { key: "coins", val: 1, label: "Coins (₹)", isCoin: true },
];

export function DayEndScreen() {
  const currentUser = useAppStore((s) => s.currentUser);
  const requestPrint = useAppStore((s) => s.requestPrint);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [openingCashStr, setOpeningCashStr] = useState("2000.00");
  const [notes, setNotes] = useState("");
  const [denominations, setDenominations] = useState<DenominationCounts>({});

  const [expectedCash, setExpectedCash] = useState<DayEndExpectedCash>({
    cashSalesPaise: 0,
    creditReceivedPaise: 0,
    cashRefundsPaise: 0,
    totalBillsCount: 0,
    totalSalesPaise: 0,
  });

  const [pastClosures, setPastClosures] = useState<DayEndClosure[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Load day transactions & past closures
  useEffect(() => {
    void (async () => {
      const repo = getRepository();
      const expected = await repo.getDayEndExpectedCash(date);
      setExpectedCash(expected);
      const closures = await repo.listDayEndClosures();
      setPastClosures(closures);
    })();
  }, [date]);

  const openingCashPaise = Math.max(0, parsePaise(openingCashStr) ?? 0);
  const countedCashPaise = computeDenominationsTotalPaise(denominations);
  const isDrawerTouched = Object.values(denominations).some((c) => (c ?? 0) > 0);

  const cashSalesPaise = Number(expectedCash?.cashSalesPaise ?? 0);
  const creditReceivedPaise = Number(expectedCash?.creditReceivedPaise ?? 0);
  const cashRefundsPaise = Number(expectedCash?.cashRefundsPaise ?? 0);
  const totalBillsCount = Number(expectedCash?.totalBillsCount ?? 0);
  const totalSalesPaise = Number(expectedCash?.totalSalesPaise ?? 0);

  const expectedDrawerCashPaise = computeExpectedDrawerCash(
    openingCashPaise,
    cashSalesPaise,
    creditReceivedPaise,
    cashRefundsPaise,
  );

  const variancePaise = computeCashVariance(countedCashPaise, expectedDrawerCashPaise);

  const handleDenominationChange = (denomKey: keyof DenominationCounts, val: string) => {
    const count = parseInt(val, 10);
    setDenominations((prev: DenominationCounts) => ({
      ...prev,
      [denomKey]: isNaN(count) || count < 0 ? 0 : count,
    }));
  };

  const handleSaveClosure = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const repo = getRepository();
      await repo.createDayEndClosure({
        closureDate: date,
        userId: currentUser?.id ?? null,
        openingCashPaise,
        cashSalesPaise,
        creditReceivedPaise,
        cashRefundsPaise,
        expectedCashPaise: expectedDrawerCashPaise,
        actualCashPaise: countedCashPaise,
        variancePaise,
        totalBillsCount,
        totalSalesPaise,
        notes: notes.trim(),
        createdAt: new Date().toISOString(),
      });

      if (currentUser) {
        await repo.recordAuditLog({
          userId: currentUser.id,
          action: "day_end_closed",
          details: `Day-end closing for ${date}: Expected ₹${formatPaise(expectedDrawerCashPaise)}, Counted ₹${formatPaise(countedCashPaise)}, Variance ₹${formatPaise(variancePaise)}`,
        });
      }

      setMessage("Day-end closing saved successfully.");
      const updated = await repo.listDayEndClosures();
      setPastClosures(updated);
      bumpDataVersion();
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handlePrintZReport = (closure?: DayEndClosure) => {
    const data: DayEndClosure = closure ?? {
      id: 0,
      closureDate: date,
      userId: currentUser?.id ?? null,
      userName: currentUser?.name ?? "Cashier",
      openingCashPaise,
      cashSalesPaise,
      creditReceivedPaise,
      cashRefundsPaise,
      expectedCashPaise: expectedDrawerCashPaise,
      actualCashPaise: countedCashPaise,
      variancePaise,
      totalBillsCount,
      totalSalesPaise,
      notes: notes.trim(),
      createdAt: new Date().toISOString(),
    };

    requestPrint({
      variant: "z-report",
      dayEndData: data,
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-gray-200 pb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Day-End Closing & Cash Drawer (Z-Report)</h1>
          <p className="text-xs text-gray-600 mt-0.5">
            Reconcile physical cash drawer notes, calculate variances, and close business day.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="date"
            data-testid="day-end-date"
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <Button
            type="button"
            variant="primary"
            data-testid="day-end-print-btn"
            onClick={() => handlePrintZReport()}
          >
            🖨️ Print Z-Report
          </Button>
        </div>
      </div>

      {message && (
        <div className={`p-3 rounded-lg text-sm ${message.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {message}
        </div>
      )}

      {/* Main Reconciliation Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Denomination Counter (7 Cols) */}
        <div className="lg:col-span-7 rounded-xl border border-gray-200 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between mb-4 border-b border-gray-100 pb-3">
            <h2 className="font-semibold text-gray-800 text-sm">Physical Cash Drawer Counter</h2>
            <button
              type="button"
              className="text-xs text-blue-600 hover:underline"
              onClick={() => setDenominations({})}
            >
              Reset Counts
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {DENOMS.map((d) => {
              const count = denominations[d.key] ?? 0;
              const subtotal = count * d.val * 100;
              return (
                <div
                  key={d.key}
                  className="flex items-center justify-between rounded-lg border border-gray-200 p-2.5 bg-gray-50/50"
                >
                  <div className="w-16">
                    <span className="font-bold text-sm text-gray-800">{d.label}</span>
                    <span className="text-[10px] text-gray-500 block">{d.isCoin ? "Coins" : "Note"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-xs">×</span>
                    <input
                      type="number"
                      min="0"
                      className="w-16 rounded border border-gray-300 bg-white px-2 py-1 text-center font-mono text-sm font-semibold"
                      data-testid={`denom-${d.val}`}
                      value={denominations[d.key] ?? ""}
                      placeholder="0"
                      onChange={(e) => handleDenominationChange(d.key, e.target.value)}
                    />
                  </div>
                  <div className="w-20 text-right font-mono text-xs font-semibold text-gray-700">
                    ₹{formatPaise(subtotal)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Counted Total */}
          <div className="mt-5 rounded-lg bg-blue-50 border border-blue-200 p-3.5 flex items-center justify-between">
            <span className="font-semibold text-blue-900 text-sm">Total Physical Cash Counted:</span>
            <span className="text-xl font-bold font-mono text-blue-900" data-testid="counted-cash-total">
              ₹{formatPaise(countedCashPaise)}
            </span>
          </div>
        </div>

        {/* Right Column: Drawer Reconciliation (5 Cols) */}
        <div className="lg:col-span-5 space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-xs">
            <h2 className="font-semibold text-gray-800 text-sm mb-4 border-b border-gray-100 pb-3">
              Drawer Balance & Variance
            </h2>

            <div className="space-y-3 text-sm">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Opening Float Cash (₹)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm font-mono"
                  data-testid="opening-cash-input"
                  value={openingCashStr}
                  onChange={(e) => setOpeningCashStr(e.target.value)}
                />
              </div>

              <div className="rounded-lg bg-gray-50 p-3 space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-600">(+) Cash Sales (Today):</span>
                  <span className="font-mono font-medium text-gray-900">
                    ₹{formatPaise(cashSalesPaise)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">(+) Credit Cust Payments:</span>
                  <span className="font-mono font-medium text-gray-900">
                    ₹{formatPaise(creditReceivedPaise)}
                  </span>
                </div>
                <div className="flex justify-between text-red-600">
                  <span>(-) Cash Refunds (Returns):</span>
                  <span className="font-mono font-medium">
                    ₹{formatPaise(cashRefundsPaise)}
                  </span>
                </div>
                <div className="border-t border-gray-200 pt-2 flex justify-between font-bold text-gray-900">
                  <span>(=) Expected Drawer Cash:</span>
                  <span className="font-mono" data-testid="expected-cash-total">
                    ₹{formatPaise(expectedDrawerCashPaise)}
                  </span>
                </div>
              </div>

              {/* Cash Variance Box */}
              <div
                data-testid="cash-variance-box"
                className={`rounded-lg p-3.5 border text-center ${
                  !isDrawerTouched
                    ? "bg-gray-50 border-gray-200 text-gray-700"
                    : variancePaise === 0
                    ? "bg-green-50 border-green-200 text-green-800"
                    : variancePaise > 0
                    ? "bg-blue-50 border-blue-200 text-blue-800"
                    : "bg-red-50 border-red-200 text-red-800"
                }`}
              >
                <div className="text-xs uppercase font-bold tracking-wider">
                  {!isDrawerTouched
                    ? t("day_end.count_hint")
                    : variancePaise === 0
                    ? "✓ Drawer Perfectly Balanced"
                    : variancePaise > 0
                    ? "Cash Surplus (+)"
                    : "Cash Shortage (-)"}
                </div>
                <div className="text-2xl font-black font-mono mt-1" data-testid="cash-variance-value">
                  {!isDrawerTouched ? "—" : `${variancePaise > 0 ? "+" : ""}₹${formatPaise(variancePaise)}`}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Closing Notes (Optional)
                </label>
                <textarea
                  rows={2}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-xs"
                  placeholder="e.g. Day-end balanced with shift cashier"
                  data-testid="day-end-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              <Button
                type="button"
                variant="primary"
                className="w-full"
                data-testid="day-end-save-btn"
                disabled={saving}
                onClick={handleSaveClosure}
              >
                {saving ? "Saving..." : "Save Day-End Closing"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Past Closures Table */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-xs">
        <h2 className="font-semibold text-gray-800 text-sm mb-3">Past Day-End Closures</h2>
        {pastClosures.length === 0 ? (
          <p className="text-xs text-gray-400 py-3">No past day-end closures recorded.</p>
        ) : (
          <table className="w-full text-xs text-left">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th className="py-2 pr-2">Date</th>
                <th className="py-2 pr-2">Cashier</th>
                <th className="py-2 pr-2 text-right">Bills</th>
                <th className="py-2 pr-2 text-right">Total Sales</th>
                <th className="py-2 pr-2 text-right">Expected</th>
                <th className="py-2 pr-2 text-right">Counted</th>
                <th className="py-2 pr-2 text-right">Variance</th>
                <th className="py-2 text-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {pastClosures.map((c) => (
                <tr key={c.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="py-2 pr-2 font-medium">{c.closureDate}</td>
                  <td className="py-2 pr-2 text-gray-600">{c.userName || "Admin"}</td>
                  <td className="py-2 pr-2 text-right font-mono">{c.totalBillsCount ?? 0}</td>
                  <td className="py-2 pr-2 text-right font-mono">₹{formatPaise(c.totalSalesPaise ?? 0)}</td>
                  <td className="py-2 pr-2 text-right font-mono">₹{formatPaise(c.expectedCashPaise ?? 0)}</td>
                  <td className="py-2 pr-2 text-right font-mono">₹{formatPaise(c.actualCashPaise ?? 0)}</td>
                  <td
                    className={`py-2 pr-2 text-right font-mono font-bold ${
                      (c.variancePaise ?? 0) === 0
                        ? "text-green-700"
                        : (c.variancePaise ?? 0) > 0
                        ? "text-blue-700"
                        : "text-red-700"
                    }`}
                  >
                    {(c.variancePaise ?? 0) > 0 ? "+" : ""}₹{formatPaise(c.variancePaise ?? 0)}
                  </td>
                  <td className="py-2 text-center">
                    <button
                      type="button"
                      className="text-blue-600 hover:underline"
                      onClick={() => handlePrintZReport(c)}
                    >
                      Print Z-Report
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
