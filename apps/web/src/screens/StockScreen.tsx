// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { formatQty, isLowStock, parseQty } from "@mytowncart-billing/core";
import type { Item, StockMovementRecord } from "@mytowncart-billing/storage";
import { t, type I18nKey } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

const inputCls = "mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm";
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

  useEffect(() => {
    void getRepository().listMovements(item.id).then(setRows);
  }, [item.id]);

  return (
    <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-3">
      <p className="mb-2 text-sm font-semibold">{t("stock.history_for", { name: item.name })}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">{t("stock.empty")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
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
  const profile = useAppStore((s) => s.profile);
  const dataVersion = useAppStore((s) => s.dataVersion);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);

  const [items, setItems] = useState<Item[]>([]);
  const [lowOnly, setLowOnly] = useState(false);
  const [adjusting, setAdjusting] = useState<Item | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setItems(await getRepository().listItems({ activeOnly: true }));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, dataVersion]);

  const threshold = profile?.lowStockThresholdMilli ?? 0;
  const visible = lowOnly
    ? items.filter((i) => isLowStock(i.stockMilli, threshold))
    : items;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold">{t("stock.title")}</h1>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="stock-low-only"
            checked={lowOnly}
            onChange={(e) => setLowOnly(e.target.checked)}
          />
          {t("stock.low_only")}
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-gray-500">{t("items.empty")}</p>
      ) : (
        <table className="w-full rounded border border-gray-200 bg-white text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
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
                  <button
                    type="button"
                    className="text-sm text-blue-600 hover:underline"
                    onClick={() => setAdjusting(item)}
                  >
                    {t("stock.adjust")}
                  </button>
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
