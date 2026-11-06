// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from "react";
import { formatPaise, formatQty, isLowStock, parseQty, serializeCsv } from "@mytowncart-billing/core";
import type { Item, StockDiscrepancyInput } from "@mytowncart-billing/storage";
import { Badge, Button, Input } from "../components/ui";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function StockAuditScreen() {
  const profile = useAppStore((s) => s.profile);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);

  const [activeTab, setActiveTab] = useState<"audit" | "reorder">("audit");
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [physicalCounts, setPhysicalCounts] = useState<Record<number, string>>({});
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [applying, setApplying] = useState(false);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadItems = async () => {
    try {
      setLoading(true);
      const list = await getRepository().listItems();
      setItems(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadItems();
  }, []);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.barcode.toLowerCase().includes(q) ||
        (item.categoryName && item.categoryName.toLowerCase().includes(q))
    );
  }, [items, search]);

  // Compute discrepancies for items where a physical count is entered
  const discrepancies = useMemo(() => {
    const list: StockDiscrepancyInput[] = [];
    for (const item of items) {
      const countStr = physicalCounts[item.id];
      if (countStr !== undefined && countStr.trim() !== "") {
        const parsedMilli = parseQty(countStr.trim());
        if (parsedMilli !== null && parsedMilli !== item.stockMilli) {
          list.push({
            itemId: item.id,
            physicalCountMilli: parsedMilli,
            reason: reasons[item.id]?.trim() || "Stock Audit Adjustment",
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
    return list;
  }, [items, physicalCounts, reasons]);

  const handleApplyAudit = async () => {
    if (discrepancies.length === 0) return;
    try {
      setApplying(true);
      setError(null);
      const count = await getRepository().applyStockAudit(discrepancies);
      setAppliedCount(count);
      setPhysicalCounts({});
      setReasons({});
      bumpDataVersion();
      await loadItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  // Reorder items: items where current stock <= low stock threshold
  const reorderItems = useMemo(() => {
    const defaultThreshold =
      profile?.lowStockThresholdMilli && profile.lowStockThresholdMilli > 0
        ? profile.lowStockThresholdMilli
        : 5000;
    return items
      .filter((item) => {
        return isLowStock(item.stockMilli, defaultThreshold);
      })
      .map((item) => {
        const threshold = defaultThreshold;
        const toOrderMilli = Math.max(threshold * 2 - item.stockMilli, threshold, 1000);
        const costPrice = item.costPricePaise ?? 0;
        const estCostPaise = Math.round((toOrderMilli * costPrice) / 1000);
        return {
          item,
          threshold,
          toOrderMilli,
          costPrice,
          estCostPaise,
        };
      });
  }, [items, profile]);

  const handleExportReorderCsv = () => {
    const header = [
      "Item Name",
      "Barcode",
      "Category",
      "Current Stock",
      "Low Stock Threshold",
      "Suggested Order Qty",
      "Unit Cost Price (INR)",
      "Estimated Cost (INR)",
    ];
    const rows = reorderItems.map((r) => [
      r.item.name,
      r.item.barcode,
      r.item.categoryName || "General",
      formatQty(r.item.stockMilli),
      formatQty(r.threshold),
      formatQty(r.toOrderMilli),
      formatPaise(r.costPrice),
      formatPaise(r.estCostPaise),
    ]);
    downloadCsv(`reorder-shopping-list-${new Date().toISOString().slice(0, 10)}.csv`, serializeCsv([header, ...rows]));
  };

  const handlePrintReorder = () => {
    window.print();
  };

  return (
    <div className="space-y-6">
      {/* Header & Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("audit.title")}</h1>
          <p className="text-xs text-gray-500 mt-1">{t("audit.intro")}</p>
        </div>

        {/* Tab switcher */}
        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
          <button
            type="button"
            data-testid="audit-tab-physical"
            onClick={() => setActiveTab("audit")}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              activeTab === "audit"
                ? "bg-white text-blue-700 shadow-xs"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {t("audit.title")}
          </button>
          <button
            type="button"
            data-testid="audit-tab-reorder"
            onClick={() => setActiveTab("reorder")}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors flex items-center gap-1.5 ${
              activeTab === "reorder"
                ? "bg-white text-blue-700 shadow-xs"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            <span>{t("audit.reorder_list")}</span>
            {reorderItems.length > 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">
                {reorderItems.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg bg-red-50 p-4 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {appliedCount !== null ? (
        <div className="rounded-lg bg-green-50 p-4 border border-green-200 text-sm text-green-700 flex items-center justify-between">
          <span>{t("audit.applied", { count: appliedCount })}</span>
          <button
            type="button"
            className="text-xs font-medium underline hover:text-green-900"
            onClick={() => setAppliedCount(null)}
          >
            {t("common.close")}
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="py-12 text-center text-sm text-gray-500">{t("common.loading")}</div>
      ) : activeTab === "audit" ? (
        /* Tab 1: Physical Stock Audit */
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="w-full sm:w-72">
              <Input
                placeholder={t("items.search_ph")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="audit-search"
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-600">
              <span>{filteredItems.length} items</span>
              <span>·</span>
              <span className="font-semibold text-blue-600">
                {discrepancies.length} discrepancies
              </span>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-xs">
            <table className="w-full text-left text-sm" data-testid="audit-table">
              <thead className="border-b border-gray-200 bg-gray-50/75 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-4 py-3">{t("print.item")}</th>
                  <th className="px-4 py-3">{t("items.category")}</th>
                  <th className="px-4 py-3 text-right">{t("audit.system_stock")}</th>
                  <th className="px-4 py-3 text-center w-36">{t("audit.physical_count")}</th>
                  <th className="px-4 py-3 text-center">{t("audit.variance")}</th>
                  <th className="px-4 py-3">{t("returns.reason")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredItems.map((item) => {
                  const countInput = physicalCounts[item.id] ?? "";
                  const parsed = countInput.trim() !== "" ? parseQty(countInput.trim()) : null;
                  const delta = parsed !== null ? parsed - item.stockMilli : null;

                  return (
                    <tr key={item.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{item.name}</p>
                        <p className="text-xs text-gray-400 font-mono">{item.barcode || "—"}</p>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{item.categoryName || "General"}</td>
                      <td className="px-4 py-3 text-right font-medium text-gray-700">
                        {formatQty(item.stockMilli)}
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="text"
                          className="w-full rounded border border-gray-300 px-2 py-1 text-center text-sm font-semibold focus:border-blue-500 focus:outline-none"
                          placeholder={formatQty(item.stockMilli)}
                          value={countInput}
                          data-testid={`audit-physical-input-${item.id}`}
                          onChange={(e) =>
                            setPhysicalCounts((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                        />
                      </td>
                      <td className="px-4 py-3 text-center">
                        {delta === null ? (
                          <span className="text-xs text-gray-400">—</span>
                        ) : delta === 0 ? (
                          <Badge variant="gray">0</Badge>
                        ) : delta > 0 ? (
                          <Badge variant="green">+{formatQty(delta)}</Badge>
                        ) : (
                          <Badge variant="red">{formatQty(delta)}</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="text"
                          className="w-full rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 focus:border-blue-500 focus:outline-none"
                          placeholder="Reason (optional)"
                          value={reasons[item.id] ?? ""}
                          onChange={(e) =>
                            setReasons((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Bottom Action Bar */}
          <div className="sticky bottom-4 flex items-center justify-between rounded-lg border border-gray-200 bg-white p-4 shadow-md">
            <div>
              <p className="text-sm font-semibold text-gray-800">
                {discrepancies.length} {discrepancies.length === 1 ? "item" : "items"} with variance
              </p>
              <p className="text-xs text-gray-500">
                Applying will record adjustment movements in inventory.
              </p>
            </div>
            <Button
              variant="primary"
              disabled={discrepancies.length === 0 || applying}
              loading={applying}
              data-testid="audit-apply-btn"
              onClick={() => void handleApplyAudit()}
            >
              {t("audit.apply")} ({discrepancies.length})
            </Button>
          </div>
        </div>
      ) : (
        /* Tab 2: Reorder Shopping List */
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <p className="text-xs text-gray-600">
              Items currently at or below minimum threshold.
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                data-testid="audit-export-reorder-btn"
                onClick={handleExportReorderCsv}
                disabled={reorderItems.length === 0}
              >
                Export CSV
              </Button>
              <Button
                variant="primary"
                size="sm"
                data-testid="audit-print-reorder-btn"
                onClick={handlePrintReorder}
                disabled={reorderItems.length === 0}
              >
                {t("audit.reorder_print")}
              </Button>
            </div>
          </div>

          {reorderItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
              No low stock items! All items are adequately stocked.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-xs">
              <table className="w-full text-left text-sm" data-testid="reorder-table">
                <thead className="border-b border-gray-200 bg-gray-50/75 text-xs font-semibold text-gray-600">
                  <tr>
                    <th className="px-4 py-3">{t("print.item")}</th>
                    <th className="px-4 py-3">{t("items.category")}</th>
                    <th className="px-4 py-3 text-right">{t("items.stock")}</th>
                    <th className="px-4 py-3 text-right">{t("audit.low_stock")}</th>
                    <th className="px-4 py-3 text-right">{t("audit.to_order")}</th>
                    <th className="px-4 py-3 text-right">{t("purchases.cost_price")}</th>
                    <th className="px-4 py-3 text-right">Est. Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {reorderItems.map((r) => (
                    <tr key={r.item.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-3 font-medium text-gray-900">{r.item.name}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{r.item.categoryName || "General"}</td>
                      <td className="px-4 py-3 text-right font-semibold text-red-600">
                        {formatQty(r.item.stockMilli)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {formatQty(r.threshold)}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-blue-600">
                        {formatQty(r.toOrderMilli)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        ₹{formatPaise(r.costPrice)}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">
                        ₹{formatPaise(r.estCostPaise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-gray-200 bg-gray-50/50 font-semibold text-sm">
                  <tr>
                    <td colSpan={6} className="px-4 py-3 text-right">
                      Total Estimated Purchase Cost:
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-gray-900">
                      ₹{formatPaise(reorderItems.reduce((acc, r) => acc + r.estCostPaise, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
