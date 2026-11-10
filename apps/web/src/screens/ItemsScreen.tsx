// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  formatPaise,
  formatQty,
  isLowStock,
  itemsToCsv,
  parseItemsCsv,
  type CsvRowError,
} from "@mytowncart-billing/core";
import type { Category, Item } from "@mytowncart-billing/storage";
import { EmptyState, PageHeader } from "../components/ui";
import { t, type I18nKey } from "../i18n";
import { setAutoSyncSetting } from "../lib/autoSync";
import { currentToken } from "../lib/connection";
import { getConnector } from "../lib/marketplace";
import { getItemPublishStatus, publishCatalogItems } from "../lib/publishService";
import { getRepository } from "../lib/repository";
import { effectiveLowStockThreshold } from "../lib/stockAlerts";
import { useAppStore } from "../store/appStore";

/** Small lazy-loaded item photo; a neutral placeholder when there is none. */
function ItemThumb({ itemId, hasPhoto, version }: { itemId: number; hasPhoto: boolean; version: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!hasPhoto) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void getRepository()
      .readItemPhoto(itemId)
      .then((photo) => {
        if (cancelled || !photo) return;
        objectUrl = URL.createObjectURL(new Blob([photo.bytes as BlobPart], { type: "image/*" }));
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [itemId, hasPhoto, version]);
  return url ? (
    <img
      src={url}
      alt=""
      className="h-10 w-10 rounded object-cover border border-gray-200"
      data-testid={`item-thumb-${itemId}`}
    />
  ) : (
    <div className="h-10 w-10 rounded bg-gray-100 border border-gray-200" aria-hidden="true" />
  );
}

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
  const autoSyncEnabled = useAppStore((s) => s.autoSyncEnabled);
  const sellerIsApproved = useAppStore((s) => s.sellerIsApproved) !== false;

  const [items, setItems] = useState<Item[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [publishingIds, setPublishingIds] = useState<Set<number>>(new Set());
  const [isBulkPublishing, setIsBulkPublishing] = useState(false);
  const [publishNotice, setPublishNotice] = useState<{ kind: "success" | "error" | "info"; text: string } | null>(null);

  const [search, setSearch] = useState("");
  const [scan, setScan] = useState("");
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<CsvRowError[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const isConnected = currentToken() !== null;

  const refresh = useCallback(async () => {
    const repo = getRepository();
    const [fetchedItems, fetchedCats] = await Promise.all([
      repo.listItems({ search: search || undefined }),
      repo.listCategories(),
    ]);
    setItems(fetchedItems);
    setCategories(fetchedCats);
  }, [search]);

  useEffect(() => {
    void refresh();
  }, [refresh, dataVersion]);

  const threshold = effectiveLowStockThreshold(profile);

  const categoryMap = useMemo(
    () => new Map(categories.map((c) => [c.id, c.marketplaceCategoryId])),
    [categories],
  );

  const changedItems = useMemo(() => {
    if (!isConnected) return [];
    return items.filter((item) => {
      const mId = item.categoryId ? categoryMap.get(item.categoryId) ?? null : null;
      const st = getItemPublishStatus(item, Boolean(mId), mId).status;
      return st === "changed" || st === "not_published";
    });
  }, [items, isConnected, categoryMap]);

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
      ...failed.map((f) => ({ row: f.index + 2, message: f.error ?? "failed" })),
    ];
    setImportMsg(t("items.import_result", { ok, total: outcomes.length }));
    setImportErrors(rowErrors);
    bumpDataVersion();
  };

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

  const toggleSelectAll = () => {
    if (items.length > 0 && items.every((i) => selectedIds.has(i.id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((i) => i.id)));
    }
  };

  const toggleSelectItem = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePublishOne = async (item: Item) => {
    setPublishingIds((prev) => new Set(prev).add(item.id));
    setPublishNotice(null);
    try {
      const res = await publishCatalogItems(
        getRepository(),
        getConnector(),
        [item],
        sellerIsApproved,
      );
      if (res.publishedCount > 0) {
        setPublishNotice({
          kind: "success",
          text: t("items.publish_success", { name: item.name }),
        });
        bumpDataVersion();
      } else if (res.blocked.length > 0) {
        const reasonCode = res.blocked[0]?.reason.code ?? "inactive";
        const reasonKey = `mtc.blocked.${reasonCode}` as I18nKey;
        setPublishNotice({
          kind: "error",
          text: `${item.name}: ${t(reasonKey)}`,
        });
      } else if (res.errors.length > 0) {
        setPublishNotice({ kind: "error", text: res.errors.join(", ") });
      }
    } catch (err) {
      setPublishNotice({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPublishingIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const handlePublishBulk = async (targets: Item[]) => {
    if (targets.length === 0) return;
    setIsBulkPublishing(true);
    setPublishNotice(null);
    try {
      const res = await publishCatalogItems(
        getRepository(),
        getConnector(),
        targets,
        sellerIsApproved,
      );
      if (res.publishedCount > 0 && res.failedCount === 0) {
        setPublishNotice({
          kind: "success",
          text: t("items.bulk_publish_success", { count: res.publishedCount }),
        });
        setSelectedIds(new Set());
        bumpDataVersion();
      } else if (res.publishedCount > 0 && res.failedCount > 0) {
        setPublishNotice({
          kind: "info",
          text: t("items.bulk_publish_partial", {
            ok: res.publishedCount,
            failed: res.failedCount,
          }),
        });
        bumpDataVersion();
      } else if (res.blocked.length > 0) {
        setPublishNotice({
          kind: "error",
          text: t("items.bulk_publish_blocked", { count: res.blocked.length }),
        });
      } else if (res.errors.length > 0) {
        setPublishNotice({ kind: "error", text: res.errors.join(", ") });
      }
    } catch (err) {
      setPublishNotice({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsBulkPublishing(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={t("items.title")}
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              data-testid="items-import-file"
              onChange={(e) => void onImportFile(e)}
            />
            {isConnected ? (
              <button
                type="button"
                onClick={() => void setAutoSyncSetting(!autoSyncEnabled)}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold shadow-xs border transition-colors ${
                  autoSyncEnabled
                    ? "bg-green-50 border-green-200 text-green-700 hover:bg-green-100"
                    : "bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100"
                }`}
                data-testid="items-auto-sync-status"
                title={autoSyncEnabled ? t("sync.auto_on_hint") : t("sync.auto_off_hint")}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    autoSyncEnabled ? "bg-green-500 animate-pulse" : "bg-amber-500"
                  }`}
                />
                {autoSyncEnabled ? t("items.auto_sync_on") : t("items.auto_sync_off")}
              </button>
            ) : null}

            {isConnected && !autoSyncEnabled && changedItems.length > 0 ? (
              <button
                type="button"
                disabled={isBulkPublishing}
                onClick={() => void handlePublishBulk(changedItems)}
                className="rounded-md bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:bg-blue-300"
                data-testid="items-publish-changed"
              >
                {isBulkPublishing
                  ? t("items.publishing")
                  : t("items.publish_changed", { count: changedItems.length })}
              </button>
            ) : null}

            <button
              type="button"
              className="rounded-md border border-gray-300 bg-white px-3.5 py-1.5 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
              onClick={() => fileRef.current?.click()}
            >
              {t("items.import_csv")}
            </button>
            <button
              type="button"
              className="rounded-md border border-gray-300 bg-white px-3.5 py-1.5 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
              onClick={onExport}
            >
              {t("items.export_csv")}
            </button>
            <Link
              to="/items/labels"
              data-testid="items-print-labels"
              className="rounded-md border border-gray-300 bg-white px-3.5 py-1.5 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
            >
              🏷️ Barcode Labels
            </Link>
            <Link
              to="/categories"
              data-testid="items-categories"
              className="rounded-md border border-gray-300 bg-white px-3.5 py-1.5 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
            >
              🏷️ {t("nav.categories")}
            </Link>
            <Link
              to="/items/new"
              data-testid="items-new"
              className="rounded-md bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
            >
              {t("items.new")}
            </Link>
          </>
        }
      />

      {/* Bulk action bar when rows are selected */}
      {selectedIds.size > 0 ? (
        <div
          className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm"
          data-testid="items-bulk-bar"
        >
          <div className="flex items-center gap-3">
            <span className="font-semibold text-blue-900">
              {t("items.selected_count", { count: selectedIds.size })}
            </span>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs font-medium text-blue-700 underline hover:text-blue-900"
            >
              {t("items.deselect_all")}
            </button>
          </div>
          {isConnected ? (
            <button
              type="button"
              disabled={isBulkPublishing}
              onClick={() => void handlePublishBulk(items.filter((i) => selectedIds.has(i.id)))}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-blue-700 disabled:bg-blue-300"
              data-testid="items-publish-selected"
            >
              {isBulkPublishing
                ? t("items.publishing")
                : t("items.publish_selected", { count: selectedIds.size })}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Publish Notice Toast */}
      {publishNotice ? (
        <div
          className={`mb-3 flex items-center justify-between rounded-lg p-3 text-sm border ${
            publishNotice.kind === "success"
              ? "bg-green-50 border-green-200 text-green-800"
              : publishNotice.kind === "info"
                ? "bg-blue-50 border-blue-200 text-blue-800"
                : "bg-red-50 border-red-200 text-red-800"
          }`}
          data-testid="items-publish-notice"
        >
          <span>{publishNotice.text}</span>
          <button
            type="button"
            onClick={() => setPublishNotice(null)}
            className="text-xs font-semibold underline ml-3"
          >
            {t("common.close")}
          </button>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="w-full max-w-sm rounded border border-gray-300 px-3 py-2 text-sm"
          placeholder={t("items.search_ph")}
          data-testid="items-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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
        <EmptyState
          title={t("items.empty")}
          hint={t("items.empty_hint")}
          action={
            <div className="flex flex-wrap gap-3">
              <Link
                to="/items/new"
                className="rounded-md bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
              >
                {t("items.add_first")}
              </Link>
              <button
                type="button"
                className="rounded-md border border-gray-300 bg-white px-3.5 py-1.5 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
                onClick={() => fileRef.current?.click()}
              >
                {t("items.import_csv")}
              </button>
            </div>
          }
        />
      ) : (
        <table className="w-full bg-white rounded-lg border border-gray-200 text-sm shadow-sm overflow-hidden">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-700 bg-gray-50 font-semibold">
              <th className="px-3 py-2 w-10 text-center">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  checked={items.length > 0 && items.every((i) => selectedIds.has(i.id))}
                  onChange={toggleSelectAll}
                  data-testid="items-select-all"
                />
              </th>
              <th className="px-3 py-2 w-14"></th>
              <th className="px-3 py-2">{t("common.name")}</th>
              <th className="px-3 py-2">{t("items.barcode")}</th>
              <th className="px-3 py-2">{t("items.category")}</th>
              <th className="px-3 py-2 text-right">{t("common.price")}</th>
              <th className="px-3 py-2 text-right">{t("items.stock")}</th>
              {isConnected ? (
                <th className="px-3 py-2 text-center">{t("items.marketplace_status")}</th>
              ) : null}
              <th className="px-3 py-2">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const mCategoryId = item.categoryId ? categoryMap.get(item.categoryId) ?? null : null;
              const statusInfo = getItemPublishStatus(item, Boolean(mCategoryId), mCategoryId);
              const isItemPublishing = publishingIds.has(item.id);

              return (
                <tr
                  key={item.id}
                  className={`border-b border-gray-100 last:border-0 ${
                    selectedIds.has(item.id) ? "bg-blue-50/40" : ""
                  }`}
                  data-testid={`item-row-${item.id}`}
                >
                  <td className="px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                      checked={selectedIds.has(item.id)}
                      onChange={() => toggleSelectItem(item.id)}
                      data-testid={`items-select-${item.id}`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <ItemThumb
                      itemId={item.id}
                      hasPhoto={!!item.photoFile}
                      version={item.imageUploadedAt ?? ""}
                    />
                  </td>
                  <td className="px-3 py-2 font-medium">
                    <div className="flex items-center gap-1.5">
                      <span>{item.name}</span>
                      {threshold > 0 && isLowStock(item.stockMilli, threshold) ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                          {t("items.low_stock")}
                        </span>
                      ) : null}
                    </div>
                    {item.brand ? (
                      <div className="text-xs text-gray-500 font-normal">{item.brand}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{item.barcode}</td>
                  <td className="px-3 py-2">{item.categoryName ?? "—"}</td>
                  <td className="px-3 py-2 text-right">₹{formatPaise(item.pricePaise)}</td>
                  <td className="px-3 py-2 text-right" data-testid={`item-stock-${item.id}`}>
                    {formatQty(item.stockMilli)}
                  </td>
                  {isConnected ? (
                    <td className="px-3 py-2 text-center">
                      <span
                        data-testid={`item-status-${item.id}`}
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${
                          statusInfo.status === "live"
                            ? "bg-green-50 border-green-200 text-green-700"
                            : statusInfo.status === "hidden"
                              ? "bg-amber-50 border-amber-200 text-amber-700"
                              : statusInfo.status === "changed"
                                ? "bg-blue-50 border-blue-200 text-blue-700"
                                : statusInfo.status === "blocked"
                                  ? "bg-amber-50 border-amber-200 text-amber-800"
                                  : statusInfo.status === "error"
                                    ? "bg-red-50 border-red-200 text-red-700"
                                    : "bg-gray-50 border-gray-200 text-gray-600"
                        }`}
                        title={
                          statusInfo.reason
                            ? t(`mtc.blocked.${statusInfo.reason}` as I18nKey)
                            : undefined
                        }
                      >
                        {statusInfo.status === "live"
                          ? t("items.status.live")
                          : statusInfo.status === "hidden"
                            ? t("items.status.hidden")
                            : statusInfo.status === "changed"
                              ? t("items.status.changed")
                              : statusInfo.status === "blocked"
                                ? t("items.status.blocked")
                                : statusInfo.status === "error"
                                  ? t("mtc.state.error")
                                  : t("items.status.not_published")}
                      </span>
                    </td>
                  ) : null}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-3">
                      <Link
                        to={`/items/${item.id}/edit`}
                        className="text-blue-600 hover:underline text-sm font-medium"
                      >
                        {t("common.edit")}
                      </Link>
                      {isConnected ? (
                        <button
                          type="button"
                          disabled={isItemPublishing || isBulkPublishing}
                          onClick={() => void handlePublishOne(item)}
                          className="text-xs font-semibold text-blue-600 hover:text-blue-800 disabled:opacity-50"
                          data-testid={`items-publish-one-${item.id}`}
                        >
                          {isItemPublishing
                            ? t("items.publishing")
                            : statusInfo.status === "changed" || statusInfo.status === "live"
                              ? t("items.republish")
                              : t("items.publish")}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
