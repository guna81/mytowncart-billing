// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { formatQty, isBatchExpired, isBatchNearExpiry, isLowStock, parseQty } from "@mytowncart-billing/core";
import type { Item, ItemBatch, StockMovementRecord } from "@mytowncart-billing/storage";
import { PageHeader } from "../components/ui";
import { t, type I18nKey } from "../i18n";
import { triggerImmediateSync } from "../lib/autoSync";
import { getRepository } from "../lib/repository";
import { useIsOwner } from "../lib/roles";
import { effectiveLowStockThreshold } from "../lib/stockAlerts";
import { useAppStore } from "../store/appStore";

const inputCls = "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 shadow-2xs";
const labelCls = "block text-sm font-medium text-gray-700";

type AdjustReason = "adjustment" | "purchase" | "import";

function AdjustDialog({
  item,
  onClose,
  onSaved,
}: {
  item: Item;
  onClose(): void;
  onSaved(): void;
}) {
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState<AdjustReason>("adjustment");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseQty(delta);
    if (parsed === null || parsed === 0) {
      setError(t("stock.delta"));
      return;
    }
    await getRepository().adjustStock(item.id, parsed, reason);
    triggerImmediateSync();
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30 p-4">
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="w-full max-w-sm rounded bg-white p-4 shadow-lg"
        data-testid="stock-adjust-dialog"
      >
        <h2 className="mb-3 font-semibold">{t("stock.adjust_title", { name: item.name })}</h2>
        <p className="mb-3 text-sm text-gray-600">
          {t("stock.current")}: {formatQty(item.stockMilli)}
        </p>
        <label className={labelCls}>
          {t("stock.delta")}
          <input
            autoFocus
            className={inputCls}
            data-testid="stock-delta"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
          />
        </label>
        <label className={`${labelCls} mt-3`}>
          {t("stock.reason")}
          <select
            className={inputCls}
            value={reason}
            onChange={(e) => setReason(e.target.value as AdjustReason)}
          >
            <option value="adjustment">{t("stock.reason.adjustment")}</option>
            <option value="purchase">{t("stock.reason.purchase")}</option>
            <option value="import">{t("stock.reason.import")}</option>
          </select>
        </label>
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            data-testid="stock-adjust-save"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
          >
            {t("common.save")}
          </button>
        </div>
      </form>
    </div>
  );
}

function MovementHistory({ item }: { item: Item }) {
  const [rows, setRows] = useState<StockMovementRecord[]>([]);
  const [batches, setBatches] = useState<ItemBatch[]>([]);

  useEffect(() => {
    void getRepository().listMovements(item.id).then(setRows);
    void getRepository().listBatchesForItem(item.id).then(setBatches);
  }, [item.id]);

  return (
    <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-3">
      {batches.length > 0 && (
        <div className="mb-3 border-b border-gray-200 pb-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-600">
            Batches & Expiry (FIFO):
          </p>
          <div className="space-y-1 text-xs font-mono">
            {batches.map((b) => {
              const expired = isBatchExpired(b.expiryDate);
              const near = isBatchNearExpiry(b.expiryDate);
              return (
                <div key={b.id} className="flex items-center justify-between">
                  <span>Batch: {b.batchNo} · Exp: {b.expiryDate}</span>
                  <span>
                    {formatQty(b.stockMilli)} units
                    {expired && <span className="ml-2 text-red-600 font-bold">EXPIRED</span>}
                    {near && !expired && <span className="ml-2 text-amber-600 font-bold">NEAR EXPIRY</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="mb-2 text-sm font-semibold">{t("stock.history_for", { name: item.name })}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">{t("stock.empty")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-600 font-semibold">
              <th className="w-1/2 py-1 pr-4">{t("stock.when")}</th>
              <th className="w-1/4 py-1 pr-4 text-right">{t("stock.delta_col")}</th>
              <th className="w-1/4 py-1">{t("stock.reason_col")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-gray-200">
                <td className="py-1 pr-4">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="py-1 pr-4 text-right font-mono">
                  {r.deltaMilli > 0 ? "+" : ""}
                  {formatQty(r.deltaMilli)}
                </td>
                <td className="py-1">{t(`stock.reason.${r.reason}` as I18nKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function StockScreen() {
  const isOwner = useIsOwner();
  const profile = useAppStore((s) => s.profile);
  const dataVersion = useAppStore((s) => s.dataVersion);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);

  const [activeTab, setActiveTab] = useState<"stock" | "expiring">("stock");
  const [items, setItems] = useState<Item[]>([]);
  const [expiringBatches, setExpiringBatches] = useState<ItemBatch[]>([]);
  const [lowOnly, setLowOnly] = useState(false);
  const [adjusting, setAdjusting] = useState<Item | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const allItems = await getRepository().listItems({ activeOnly: true });
    setItems(allItems);
    const expiring = await getRepository().listExpiringBatches(60);
    setExpiringBatches(expiring);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, dataVersion]);

  const threshold = effectiveLowStockThreshold(profile);
  const visible = lowOnly
    ? items.filter((i) => threshold > 0 && isLowStock(i.stockMilli, threshold))
    : items;

  const itemMap = new Map<number, Item>(items.map((i) => [i.id, i]));

  return (
    <div>
      <PageHeader
        title={t("stock.title")}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex rounded-lg bg-gray-200/80 p-0.5 text-xs font-semibold">
              <button
                type="button"
                data-testid="stock-tab-all"
                onClick={() => setActiveTab("stock")}
                className={`rounded-md px-3 py-1.5 transition-colors ${
                  activeTab === "stock"
                    ? "bg-white text-gray-900 shadow-xs"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Current Stock
              </button>
              <button
                type="button"
                data-testid="stock-tab-expiring"
                onClick={() => setActiveTab("expiring")}
                className={`rounded-md px-3 py-1.5 transition-colors flex items-center gap-1.5 ${
                  activeTab === "expiring"
                    ? "bg-white text-gray-900 shadow-xs"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                <span>Expiring Batches</span>
                {expiringBatches.length > 0 && (
                  <span className="rounded-full bg-amber-500 px-1.5 py-0.2 text-[10px] text-white font-bold">
                    {expiringBatches.length}
                  </span>
                )}
              </button>
            </div>

            {activeTab === "stock" && (
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  data-testid="stock-low-only"
                  checked={lowOnly}
                  onChange={(e) => setLowOnly(e.target.checked)}
                />
                {t("stock.low_only")}
              </label>
            )}
          </div>
        }
      />

      {activeTab === "expiring" ? (
        <div data-testid="expiring-batches-table">
          {expiringBatches.length === 0 ? (
            <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500 text-sm">
              No batches expiring within the next 60 days. All inventory is fresh.
            </div>
          ) : (
            <table className="w-full rounded border border-gray-200 bg-white text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-600 font-semibold">
                  <th className="px-3 py-2">{t("print.item")}</th>
                  <th className="px-3 py-2">Batch No</th>
                  <th className="px-3 py-2">Expiry Date</th>
                  <th className="px-3 py-2 text-right">Available Units</th>
                  <th className="px-3 py-2 text-center">Status</th>
                </tr>
              </thead>
              <tbody>
                {expiringBatches.map((b) => {
                  const item = itemMap.get(b.itemId);
                  const expired = isBatchExpired(b.expiryDate);
                  return (
                    <tr key={b.id} className="border-b border-gray-100 last:border-0">
                      <td className="px-3 py-2 font-medium text-gray-900">
                        {item?.name || `Item #${b.itemId}`}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{b.batchNo}</td>
                      <td className="px-3 py-2 font-mono text-xs">{b.expiryDate}</td>
                      <td className="px-3 py-2 text-right font-mono font-medium">
                        {formatQty(b.stockMilli)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {expired ? (
                          <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
                            EXPIRED
                          </span>
                        ) : (
                          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
                            Expiring Soon
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : visible.length === 0 ? (
        <p className="text-sm text-gray-500">{t("items.empty")}</p>
      ) : (
        <table className="w-full rounded border border-gray-200 bg-white text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-600 font-semibold">
              <th className="px-3 py-2">{t("common.name")}</th>
              <th className="px-3 py-2">{t("items.barcode")}</th>
              <th className="px-3 py-2 text-right">{t("stock.current")}</th>
              <th className="px-3 py-2">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => (
              <tr key={item.id} className="border-b border-gray-100 last:border-0">
                <td className="px-3 py-2 font-medium">
                  <button
                    type="button"
                    className="hover:underline"
                    onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                  >
                    {item.name}
                  </button>
                  {isLowStock(item.stockMilli, threshold) ? (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                      {t("items.low_stock")}
                    </span>
                  ) : null}
                  {expanded === item.id ? <MovementHistory item={item} /> : null}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{item.barcode}</td>
                <td className="px-3 py-2 text-right" data-testid={`stock-${item.id}`}>
                  {formatQty(item.stockMilli)}
                </td>
                <td className="px-3 py-2">
                  {isOwner ? (
                    <button
                      type="button"
                      className="text-sm text-blue-600 hover:underline"
                      onClick={() => setAdjusting(item)}
                    >
                      {t("stock.adjust")}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adjusting ? (
        <AdjustDialog
          item={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            setAdjusting(null);
            bumpDataVersion();
          }}
        />
      ) : null}
    </div>
  );
}
