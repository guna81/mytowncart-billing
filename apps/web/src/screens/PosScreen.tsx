// SPDX-License-Identifier: Apache-2.0
/**
 * Billing / POS (roadmap §8.8): barcode- and keyboard-first. A USB scanner is a
 * keyboard wedge, so Enter in the scan field adds a line and immediately
 * refocuses — the seller rarely touches the mouse.
 *
 * Shortcuts: F2 focus scanner · F4 hold · F9 save & print.
 * A count item sold by weight is rejected by `validateBill` (unitKind check).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import {
  computeBill,
  computeChangePaise,
  financialYearFor,
  formatPaise,
  formatQty,
  isoDateOf,
  localIsoTimestamp,
  parsePaise,
  parseQty,
  PAYMENT_MODES,
  validateBill,
  type BillLineInput,
  type PaymentMode,
} from "@mytowncart-billing/core";
import type { HeldBill, Item } from "@mytowncart-billing/storage";
import { t, type I18nKey } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

type Line = BillLineInput & { key: string };

let lineSeq = 1;

export function PosScreen() {
  const profile = useAppStore((s) => s.profile);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);
  const requestPrint = useAppStore((s) => s.requestPrint);
  const [held, setHeld] = useState<HeldBill[]>([]);
  const [heldItem, setHeldItem] = useState<HeldBill | null>(null);
  const [heldError, setHeldError] = useState<string | null>(null);

  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<PaymentMode>("cash");
  const [tendered, setTendered] = useState("");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customers, setCustomers] = useState<{ id: number; name: string }[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const scanRef = useRef<HTMLInputElement>(null);

  const focusScan = useCallback(() => {
    scanRef.current?.focus();
    scanRef.current?.select();
  }, []);

  const refreshHeld = useCallback(async () => {
    setHeld(await getRepository().listHeldBills());
  }, []);

  useEffect(() => {
    focusScan();
    void getRepository()
      .listCustomers()
      .then((rows) => setCustomers(rows.map((c) => ({ id: c.id, name: c.name }))));
    void refreshHeld();
  }, [focusScan, refreshHeld]);

  const bill = computeBill(lines, {
    pricesIncludeTax: profile?.pricesIncludeTax ?? true,
  });

  const paidPaise = (() => {
    if (mode === "cash") return parsePaise(tendered) ?? (tendered === "" ? 0 : -1);
    return bill.totalPaise;
  })();
  const payments =
    mode === "cash"
      ? tendered === ""
        ? [{ mode, amountPaise: bill.totalPaise }]
        : [{ mode, amountPaise: Math.max(0, paidPaise) }]
      : [{ mode, amountPaise: bill.totalPaise }];
  const change = computeChangePaise(bill, payments);

  const addItem = (item: Item, qtyMilli = 1000) => {
    setLines((current) => {
      const existing = current.findIndex((l) => l.itemId === item.id);
      if (existing >= 0) {
        const next = [...current];
        const line = next[existing]!;
        next[existing] = { ...line, qtyMilli: line.qtyMilli + qtyMilli };
        return next;
      }
      return [
        ...current,
        {
          key: `l${lineSeq++}`,
          itemId: item.id,
          name: item.name,
          qtyMilli,
          unitPricePaise: item.pricePaise,
          taxRateBp: item.taxRateBp,
          unitKind: item.unitKind,
        },
      ];
    });
  };

  const onScan = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const repo = getRepository();
    let item = await repo.findItemByBarcode(trimmed);
    if (!item) {
      const matches = await repo.listItems({ search: trimmed, activeOnly: true });
      if (matches.length === 1) item = matches[0]!;
      else if (matches.length > 1) {
        setNotice({
          kind: "error",
          text: `${matches.length} items match — type a barcode.`,
        });
        return;
      }
    }
    if (!item) {
      setNotice({ kind: "error", text: t("pos.not_found", { query: trimmed }) });
      return;
    }
    addItem(item);
    setNotice(null);
    setQuery("");
    focusScan();
  };

  const setQty = (key: string, text: string) => {
    const parsed = parseQty(text);
    if (parsed === null || parsed <= 0) return;
    setLines((current) =>
      current.map((l) => (l.key === key ? { ...l, qtyMilli: parsed } : l)),
    );
  };

  const removeLine = (key: string) =>
    setLines((current) => current.filter((l) => l.key !== key));

  const resetBill = () => {
    setLines([]);
    setQuery("");
    setTendered("");
    setCustomerId(null);
    setNotice(null);
    setHeldItem(null);
    setHeldError(null);
    focusScan();
  };

  const save = async (print: boolean) => {
    if (busy) return;
    setNotice(null);
    const errors = validateBill(bill, payments);
    if (errors.length > 0) {
      const first = errors[0]!;
      const message =
        first === "payment.insufficient"
          ? t("pos.error.insufficient")
          : first === "payment.overpay_requires_cash"
            ? t("pos.error.overpay_requires_cash")
            : first === "bill.no_lines"
              ? t("pos.error.no_lines")
              : first;
      setNotice({ kind: "error", text: message });
      return;
    }
    setBusy(true);
    try {
      const now = new Date();
      const created = await getRepository().createBill({
        fy: financialYearFor(isoDateOf(now)),
        prefix: profile?.invoicePrefix ?? "INV-",
        customerId,
        subtotalPaise: bill.subtotalPaise,
        taxPaise: bill.taxPaise,
        totalPaise: bill.totalPaise,
        createdAt: localIsoTimestamp(now),
        lines: bill.lines.map((l) => ({
          itemId: l.itemId,
          nameSnapshot: l.name,
          qtyMilli: l.qtyMilli,
          unitPricePaise: l.unitPricePaise,
          taxRateBp: l.taxRateBp,
          taxPaise: l.taxPaise,
          totalPaise: l.totalPaise,
        })),
        payments,
      });
      setNotice({ kind: "ok", text: t("pos.saved", { number: created.number }) });
      // The bill that was resumed (if any) is now a real bill; drop the hold.
      if (heldItem) {
        await getRepository().takeHeldBill(heldItem.id);
        await refreshHeld();
      }
      resetBill();
      bumpDataVersion();
      if (print) requestPrint({ billId: created.billId, variant: "receipt-80" });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Held bills keep only item ids + quantities: prices, names and the
   * customer are applied fresh on resume, so a bill parked before a price
   * change is not silently sold at yesterday's price.
   */
  const hold = async () => {
    if (lines.length === 0) return;
    setHeldError(null);
    await getRepository().saveHeldBill({
      label: `${formatQty(lines.reduce((s, l) => s + l.qtyMilli, 0))} item(s)`,
      customerId,
      lines: lines.map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli })),
    });
    resetBill();
    await refreshHeld();
  };

  const resume = async (id: number) => {
    setHeldError(null);
    const repo = getRepository();
    const parked = held.find((h) => h.id === id);
    if (!parked) return;
    const restored: Line[] = [];
    const missing: string[] = [];
    for (const line of parked.lines) {
      const item = await repo.getItem(line.itemId);
      if (!item) {
        missing.push(`#${line.itemId}`);
        continue;
      }
      restored.push({
        key: `l${lineSeq++}`,
        itemId: item.id,
        name: item.name,
        qtyMilli: line.qtyMilli,
        unitPricePaise: item.pricePaise,
        taxRateBp: item.taxRateBp,
        unitKind: item.unitKind,
      });
    }
    if (restored.length === 0) {
      setHeldError(t("pos.resume_all_missing"));
      return;
    }
    setLines(restored);
    setCustomerId(parked.customerId);
    setHeldItem(parked);
    if (missing.length > 0) setHeldError(t("pos.resume_partial", { items: missing.join(", ") }));
    focusScan();
  };

  /** Forget a held bill (e.g. the customer left) without loading it. */
  const discardHeld = async (id: number) => {
    if (!window.confirm(t("pos.discard_confirm"))) return;
    await getRepository().takeHeldBill(id);
    if (heldItem?.id === id) setHeldItem(null);
    await refreshHeld();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "F2") {
      e.preventDefault();
      focusScan();
    } else if (e.key === "F4") {
      e.preventDefault();
      void hold();
    } else if (e.key === "F9") {
      e.preventDefault();
      void save(true);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_20rem]" onKeyDown={onKeyDown}>
      <div>
        <div className="mb-3 flex gap-2">
          <input
            ref={scanRef}
            className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder={t("pos.scan_ph")}
            data-testid="pos-scan"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void onScan(query);
              }
            }}
          />
          <button
            type="button"
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
            data-testid="pos-hold"
            onClick={() => void hold()}
          >
            {t("pos.hold")}
          </button>
        </div>

        {notice ? (
          <p
            className={`mb-3 rounded px-3 py-2 text-sm ${
              notice.kind === "ok"
                ? "bg-green-50 text-green-700"
                : "bg-red-50 text-red-700"
            }`}
            data-testid="pos-notice"
          >
            {notice.text}
          </p>
        ) : null}

        {lines.length === 0 ? (
          <p className="rounded border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500">
            {t("pos.empty")}
          </p>
        ) : (
          <table className="w-full rounded border border-gray-200 bg-white text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="px-3 py-2">{t("print.item")}</th>
                <th className="px-3 py-2 text-right">{t("common.qty")}</th>
                <th className="px-3 py-2 text-right">{t("common.price")}</th>
                <th className="px-3 py-2 text-right">{t("common.total")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {bill.lines.map((l, index) => {
                const line = lines[index]!;
                return (
                  <tr key={line.key} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-2 font-medium">{l.name}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        className="w-20 rounded border border-gray-300 px-2 py-1 text-right text-sm"
                        data-testid={`pos-qty-${line.itemId}`}
                        defaultValue={formatQty(l.qtyMilli)}
                        onBlur={(e) => setQty(line.key, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            setQty(line.key, (e.target as HTMLInputElement).value);
                          }
                        }}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">{formatPaise(l.unitPricePaise)}</td>
                    <td className="px-3 py-2 text-right font-medium">
                      ₹{formatPaise(l.totalPaise)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="text-sm text-red-600 hover:underline"
                        onClick={() => removeLine(line.key)}
                      >
                        {t("pos.remove_line")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {heldError ? (
          <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="pos-held-error">
            {heldError}
          </p>
        ) : null}
        <div className="mt-4 rounded border border-gray-200 bg-white p-3" data-testid="pos-held">
          <p className="mb-2 text-sm font-semibold">{t("pos.resume")}</p>
          {held.length === 0 ? (
            <p className="text-sm text-gray-500">{t("pos.resume_empty")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {held.map((p) => (
                <span key={p.id} className="inline-flex items-center rounded border border-gray-300">
                  <button
                    type="button"
                    className="px-3 py-1 text-sm hover:bg-gray-50"
                    data-testid={`pos-resume-${p.id}`}
                    onClick={() => void resume(p.id)}
                  >
                    {p.label} · {new Date(p.createdAt).toLocaleTimeString()}
                  </button>
                  <button
                    type="button"
                    className="border-l border-gray-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    aria-label={t("pos.discard")}
                    data-testid={`pos-discard-${p.id}`}
                    onClick={() => void discardHeld(p.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <aside className="h-fit rounded border border-gray-200 bg-white p-4">
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-gray-600">{t("pos.subtotal")}</dt>
            <dd>{formatPaise(bill.subtotalPaise)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-600">{t("pos.tax")}</dt>
            <dd>{formatPaise(bill.taxPaise)}</dd>
          </div>
          <div className="flex justify-between border-t border-gray-200 pt-1 text-base font-bold">
            <dt>{t("pos.total")}</dt>
            <dd data-testid="pos-total">₹{formatPaise(bill.totalPaise)}</dd>
          </div>
        </dl>

        <label className="mt-4 block text-sm font-medium">
          {t("pos.payment_mode")}
          <div className="mt-1 grid grid-cols-2 gap-1">
            {PAYMENT_MODES.map((m) => (
              <button
                key={m}
                type="button"
                data-testid={`pos-mode-${m}`}
                className={`rounded border px-2 py-1.5 text-sm ${
                  mode === m
                    ? "border-blue-600 bg-blue-50 text-blue-700 font-semibold"
                    : "border-gray-300 hover:bg-gray-50"
                }`}
                onClick={() => {
                  setMode(m);
                  setTendered("");
                }}
              >
                {t(`pos.mode.${m}` as I18nKey)}
              </button>
            ))}
          </div>
        </label>

        {mode === "cash" ? (
          <label className="mt-3 block text-sm font-medium">
            {t("pos.tendered")}
            <input
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              data-testid="pos-tendered"
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
            />
          </label>
        ) : null}

        {change > 0 ? (
          <p className="mt-2 text-sm text-green-700">
            {t("pos.change", { amount: formatPaise(change) })}
          </p>
        ) : null}

        <label className="mt-3 block text-sm font-medium">
          {t("pos.customer")}
          <select
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
            value={customerId ?? ""}
            onChange={(e) => setCustomerId(e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">{t("common.none")}</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-4 space-y-2">
          <button
            type="button"
            data-testid="pos-save-print"
            disabled={busy}
            className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            onClick={() => void save(true)}
          >
            {t("pos.save_print")}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
              onClick={() => void save(false)}
            >
              {t("pos.save")}
            </button>
            <button
              type="button"
              className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
              onClick={resetBill}
            >
              {t("pos.clear")}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
