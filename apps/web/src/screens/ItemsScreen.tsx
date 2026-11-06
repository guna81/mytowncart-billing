// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  formatPaise,
  formatQty,
  isLowStock,
  itemsToCsv,
  parseItemsCsv,
  type CsvRowError,
} from "@mytowncart-billing/core";
import type { Item } from "@mytowncart-billing/storage";
import { t } from "../i18n";
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

export function ItemsScreen() {
  const navigate = useNavigate();
  const profile = useAppStore((s) => s.profile);
  const dataVersion = useAppStore((s) => s.dataVersion);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);
  const [items, setItems] = useState<Item[]>([]);
  const [search, setSearch] = useState("");
  const [scan, setScan] = useState("");
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<CsvRowError[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setItems(await getRepository().listItems({ search: search || undefined }));
  }, [search]);

  useEffect(() => {
    void refresh();
  }, [refresh, dataVersion]);

  const threshold = profile?.lowStockThresholdMilli ?? 0;

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await importFile(file);
    } finally {
      input.value = "";
    }
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseItemsCsv(text);
    const repo = getRepository();
    // Resolve category names to ids (creating categories) before import.
    const inputs = [];
    for (const draft of parsed.items) {
      let categoryId: number | null = null;
      if (draft.category !== "") {
        categoryId = await repo.upsertCategory({ name: draft.category });
      }
      inputs.push({
        name: draft.name,
        barcode: draft.barcode,
        categoryId,
        unitKind: draft.unitKind,
        pricePaise: draft.pricePaise,
        mrpPaise: draft.mrpPaise,
        taxRateBp: draft.taxRateBp,
        openingStockMilli: draft.openingStockMilli,
        isActive: true,
      });
    }
    const outcomes = await repo.importItems(inputs);
    const ok = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.filter((o) => !o.ok);
    const rowErrors: CsvRowError[] = [
      ...parsed.errors,
      // Storage failures map back to file lines: +1 for the header, +1 for 1-based lines.
      ...failed.map((f) => ({ row: f.index + 2, message: f.error ?? "failed" })),
    ];
    setImportMsg(t("items.import_result", { ok, total: outcomes.length }));
    setImportErrors(rowErrors);
    bumpDataVersion();
  };

  /**
   * Scanned code → the matching item: exact barcode first, then a single
   * exact name match. Several name matches are refused rather than guessed.
   */
  const onScanLookup = async (value: string) => {
    const code = value.trim();
    if (code === "") return;
    const repo = getRepository();
    const byBarcode = await repo.findItemByBarcode(code);
    if (byBarcode) {
      setScanNotice(null);
      setScan("");
      navigate(`/items/${byBarcode.id}/edit`);
      return;
    }
    const matches = await repo.listItems({ search: code, activeOnly: false });
    const exact = matches.filter((m) => m.name.toLowerCase() === code.toLowerCase());
    if (exact.length === 1) {
      setScanNotice(null);
      setScan("");
      navigate(`/items/${exact[0]!.id}/edit`);
      return;
    }
    setScanNotice(
      matches.length > 0
        ? t("items.scan_ambiguous", { query: code })
        : t("items.scan_not_found", { query: code }),
    );
  };

  const onExport = () => {
    const csv = itemsToCsv(
      items.map((i) => ({
        name: i.name,
        barcode: i.barcode,
        category: i.categoryName ?? "",
        unitKind: i.unitKind,
        pricePaise: i.pricePaise,
        mrpPaise: i.mrpPaise,
        taxRateBp: i.taxRateBp,
        stockMilli: i.stockMilli,
      })),
    );
    downloadText("items.csv", csv);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-bold">{t("items.title")}</h1>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            data-testid="items-import-file"
            onChange={(e) => void onImportFile(e)}
          />
          <button
            type="button"
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={() => fileRef.current?.click()}
          >
            {t("items.import_csv")}
          </button>
          <button
            type="button"
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onExport}
          >
            {t("items.export_csv")}
          </button>
          <Link
            to="/items/labels"
            data-testid="items-print-labels"
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 text-gray-700"
          >
            🏷️ Barcode Labels
          </Link>
          <Link
            to="/items/new"
            data-testid="items-new"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
          >
            {t("items.new")}
          </Link>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="w-full max-w-sm rounded border border-gray-300 px-3 py-2 text-sm"
          placeholder={t("items.search_ph")}
          data-testid="items-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {/* A USB scanner is a keyboard wedge: Enter opens the only exact match. */}
        <input
          className="w-full max-w-xs rounded border border-gray-300 px-3 py-2 font-mono text-sm"
          placeholder={t("items.scan_ph")}
          data-testid="items-scan"
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void onScanLookup(scan);
            }
          }}
        />
        {scanNotice ? (
          <span className="text-sm text-amber-800" data-testid="items-scan-notice">
            {scanNotice}
          </span>
        ) : null}
      </div>

      {importMsg ? <p className="mb-2 text-sm text-green-700">{importMsg}</p> : null}
      {importErrors.length > 0 ? (
        <div className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p className="font-semibold">{t("items.import_errors")}</p>
          <ul className="list-disc pl-5">
            {importErrors.map((e, i) => (
              <li key={i}>{t("items.row", { row: e.row, message: e.message })}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="text-sm text-gray-500">{t("items.empty")}</p>
      ) : (
        <table className="w-full bg-white rounded border border-gray-200 text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="px-3 py-2">{t("common.name")}</th>
              <th className="px-3 py-2">{t("items.barcode")}</th>
              <th className="px-3 py-2">{t("items.category")}</th>
              <th className="px-3 py-2 text-right">{t("common.price")}</th>
              <th className="px-3 py-2 text-right">{t("items.stock")}</th>
              <th className="px-3 py-2">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-gray-100 last:border-0">
                <td className="px-3 py-2 font-medium">
                  {item.name}
                  {isLowStock(item.stockMilli, threshold) ? (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                      {t("items.low_stock")}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{item.barcode}</td>
                <td className="px-3 py-2">{item.categoryName ?? "—"}</td>
                <td className="px-3 py-2 text-right">₹{formatPaise(item.pricePaise)}</td>
                <td className="px-3 py-2 text-right" data-testid={`item-stock-${item.id}`}>
                  {formatQty(item.stockMilli)}
                </td>
                <td className="px-3 py-2">
                  <Link
                    to={`/items/${item.id}/edit`}
                    className="text-blue-600 hover:underline text-sm"
                  >
                    {t("common.edit")}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
