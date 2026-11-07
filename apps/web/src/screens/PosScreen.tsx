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
  computeLoyaltyPointsEarned,
  computeLoyaltyRedemption,
  DEFAULT_LOYALTY_CONFIG,
  financialYearFor,
  formatPaise,
  formatQty,
  isBatchExpired,
  isBatchNearExpiry,
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
import { UpiQrCode } from "../components/UpiQrCode";
import { EmptyState } from "../components/ui";
import { t, type I18nKey } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

type Line = BillLineInput & { key: string; batchNo?: string; expiryDate?: string };

let lineSeq = 1;

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function PosScreen() {
  const profile = useAppStore((s) => s.profile);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);
  const requestPrint = useAppStore((s) => s.requestPrint);
  const [held, setHeld] = useState<HeldBill[]>([]);
  const [heldItem, setHeldItem] = useState<HeldBill | null>(null);
  const [heldError, setHeldError] = useState<string | null>(null);

  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Item[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(-1);

  const [mode, setMode] = useState<PaymentMode | "split">("cash");
  const [tendered, setTendered] = useState("");
  const [splitAmounts, setSplitAmounts] = useState<{
    cash: string;
    upi: string;
    card: string;
    credit: string;
  }>({ cash: "", upi: "", card: "", credit: "" });

  const [billDiscountStr, setBillDiscountStr] = useState("");
  const [roundOffEnabled, setRoundOffEnabled] = useState(true);

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerLoyaltyBalance, setCustomerLoyaltyBalance] = useState(0);
  const [redeemedPoints, setRedeemedPoints] = useState(0);
  const [customers, setCustomers] = useState<{ id: number; name: string }[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const scanRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const focusScan = useCallback(() => {
    scanRef.current?.focus();
    scanRef.current?.select();
  }, []);

  const refreshHeld = useCallback(async () => {
    try {
      setHeld(await getRepository().listHeldBills());
    } catch (err: unknown) {
      setNotice({ kind: "error", text: errMsg(err) });
    }
  }, []);

  useEffect(() => {
    focusScan();
    void getRepository()
      .listCustomers()
      .then((rows) => setCustomers(rows.map((c) => ({ id: c.id, name: c.name }))));
    void refreshHeld();
  }, [focusScan, refreshHeld]);

  // Load loyalty balance when customer selected
  useEffect(() => {
    if (customerId) {
      void getRepository()
        .getCustomerLoyaltyBalance(customerId)
        .then(setCustomerLoyaltyBalance);
    } else {
      setCustomerLoyaltyBalance(0);
      setRedeemedPoints(0);
    }
  }, [customerId]);

  // Search-as-you-type suggestions
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSuggestions([]);
      setHighlightIndex(-1);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void getRepository()
        .listItems({ search: trimmed, activeOnly: true })
        .then((items) => {
          if (active) {
            setSuggestions(items.slice(0, 8));
            setHighlightIndex(-1);
          }
        });
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  const manualDiscountPaise = Math.max(0, parsePaise(billDiscountStr) ?? 0);
  const subtotalPaise = lines.reduce(
    (s, l) => s + Math.floor((l.qtyMilli * l.unitPricePaise) / 1000),
    0,
  );
  const loyaltyRedemption = computeLoyaltyRedemption(
    customerLoyaltyBalance,
    redeemedPoints,
    subtotalPaise,
    DEFAULT_LOYALTY_CONFIG.pointValuePaise,
    DEFAULT_LOYALTY_CONFIG.minPointsToRedeem,
  );
  const loyaltyDiscountPaise = loyaltyRedemption.discountPaise;
  const billDiscountPaise = manualDiscountPaise + loyaltyDiscountPaise;

  const bill = computeBill(lines, {
    pricesIncludeTax: profile?.pricesIncludeTax ?? true,
    billDiscountPaise,
    roundOff: roundOffEnabled,
  });

  const getComputedPayments = (): { mode: PaymentMode; amountPaise: number }[] => {
    if (mode === "split") {
      const pCash = parsePaise(splitAmounts.cash) ?? 0;
      const pUpi = parsePaise(splitAmounts.upi) ?? 0;
      const pCard = parsePaise(splitAmounts.card) ?? 0;
      const pCredit = parsePaise(splitAmounts.credit) ?? 0;
      const res: { mode: PaymentMode; amountPaise: number }[] = [];
      if (pCash > 0) res.push({ mode: "cash", amountPaise: pCash });
      if (pUpi > 0) res.push({ mode: "upi", amountPaise: pUpi });
      if (pCard > 0) res.push({ mode: "card", amountPaise: pCard });
      if (pCredit > 0) res.push({ mode: "credit", amountPaise: pCredit });
      return res;
    }
    if (mode === "cash") {
      const paidPaise = parsePaise(tendered) ?? (tendered === "" ? bill.totalPaise : -1);
      return [{ mode: "cash", amountPaise: Math.max(0, paidPaise) }];
    }
    return [{ mode, amountPaise: bill.totalPaise }];
  };

  const payments = getComputedPayments();
  const change = mode === "cash" ? computeChangePaise(bill, payments) : 0;

  const addItem = async (item: Item, qtyMilli = 1000): Promise<boolean> => {
    let batchNo: string | undefined = undefined;
    let expiryDate: string | undefined = undefined;

    try {
      const batches = await getRepository().listBatchesForItem(item.id);
      const available = batches.filter((b) => b.stockMilli > 0);
      if (available.length > 0) {
        const earliest = available[0]!;
        if (isBatchExpired(earliest.expiryDate)) {
          setNotice({
            kind: "error",
            text: `Cannot sell ${item.name}: Batch ${earliest.batchNo} is EXPIRED (${earliest.expiryDate})!`,
          });
          return false;
        }
        if (isBatchNearExpiry(earliest.expiryDate)) {
          setNotice({
            kind: "error",
            text: `Notice: ${item.name} Batch ${earliest.batchNo} expires soon on ${earliest.expiryDate}.`,
          });
        }
        batchNo = earliest.batchNo;
        expiryDate = earliest.expiryDate;
      }
    } catch {
      // Continue if no batches
    }

    setLines((current) => {
      const existing = current.findIndex((l) => l.itemId === item.id);
      if (existing >= 0) {
        const next = [...current];
        const line = next[existing]!;
        next[existing] = {
          ...line,
          qtyMilli: line.qtyMilli + qtyMilli,
          batchNo: batchNo || line.batchNo,
          expiryDate: expiryDate || line.expiryDate,
        };
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
          hsnCode: item.hsnCode || undefined,
          discountPaise: 0,
          batchNo,
          expiryDate,
        },
      ];
    });
    return true;
  };

  const pickSuggestion = async (item: Item) => {
    const ok = await addItem(item);
    if (ok) {
      setQuery("");
      setSuggestions([]);
      setHighlightIndex(-1);
      setNotice(null);
      focusScan();
    }
  };

  const onScan = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const repo = getRepository();
    let scanQtyMilli = 1000;
    let item = await repo.findItemByBarcode(trimmed);
    if (!item) {
      const multi = await repo.lookupItemByAnyBarcode(trimmed);
      if (multi) {
        item = await repo.getItem(multi.itemId);
        scanQtyMilli = multi.packQtyMilli;
      }
    }
    if (!item) {
      const matches = await repo.listItems({ search: trimmed, activeOnly: true });
      if (matches.length === 1) item = matches[0]!;
      else if (matches.length > 1) {
        setNotice({
          kind: "error",
          text: `${matches.length} items match — type a barcode or select from dropdown.`,
        });
        return;
      }
    }
    if (!item) {
      setNotice({ kind: "error", text: t("pos.not_found", { query: trimmed }) });
      return;
    }
    const ok = await addItem(item, scanQtyMilli);
    if (ok) {
      setNotice(null);
      setQuery("");
      setSuggestions([]);
      setHighlightIndex(-1);
      focusScan();
    }
  };

  const setQty = (key: string, text: string) => {
    const parsed = parseQty(text);
    if (parsed === null || parsed <= 0) return;
    setLines((current) =>
      current.map((l) => (l.key === key ? { ...l, qtyMilli: parsed } : l)),
    );
  };

  const stepQty = (key: string, deltaMilli: number) => {
    setLines((current) =>
      current.map((l) => {
        if (l.key !== key) return l;
        const next = l.qtyMilli + deltaMilli;
        return next > 0 ? { ...l, qtyMilli: next } : l;
      }),
    );
  };

  const setLineDiscount = (key: string, text: string) => {
    const parsed = parsePaise(text);
    setLines((current) =>
      current.map((l) =>
        l.key === key ? { ...l, discountPaise: parsed !== null && parsed > 0 ? parsed : 0 } : l,
      ),
    );
  };

  const removeLine = (key: string) =>
    setLines((current) => current.filter((l) => l.key !== key));

  const resetBill = (keepNotice = false) => {
    setLines([]);
    setQuery("");
    setSuggestions([]);
    setHighlightIndex(-1);
    setTendered("");
    setSplitAmounts({ cash: "", upi: "", card: "", credit: "" });
    setBillDiscountStr("");
    setCustomerId(null);
    setRedeemedPoints(0);
    setCustomerLoyaltyBalance(0);
    if (!keepNotice) setNotice(null);
    setHeldItem(null);
    setHeldError(null);
    focusScan();
  };

  const save = async (print: boolean) => {
    if (busy) return;
    setNotice(null);

    // If split mode and credit is used, customer is required
    const hasCredit = payments.some((p) => p.mode === "credit");
    if (hasCredit && customerId === null) {
      setNotice({ kind: "error", text: t("pos.error.credit_requires_customer") });
      return;
    }

    const errors = validateBill(bill, payments, { customerId });
    if (errors.length > 0) {
      const first = errors[0]!;
      const message =
        first === "payment.insufficient"
          ? t("pos.error.insufficient")
          : first === "payment.overpay_requires_cash"
            ? t("pos.error.overpay_requires_cash")
            : first === "payment.change_exceeds_cash"
              ? t("pos.error.change_exceeds_cash")
              : first === "bill.no_lines"
              ? t("pos.error.no_lines")
              : first === "payment.credit_requires_customer"
                ? t("pos.error.credit_requires_customer")
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
        discountPaise: bill.discountPaise,
        roundOffPaise: bill.roundOffPaise,
        // Saved in the same transaction as the bill, so points can never drift from sales.
        loyaltyEarned: customerId
          ? computeLoyaltyPointsEarned(bill.totalPaise, DEFAULT_LOYALTY_CONFIG.earnRatePaise)
          : 0,
        loyaltyRedeemed: customerId ? redeemedPoints : 0,
        createdAt: localIsoTimestamp(now),
        lines: bill.lines.map((l) => ({
          itemId: l.itemId,
          nameSnapshot: l.name,
          qtyMilli: l.qtyMilli,
          unitPricePaise: l.unitPricePaise,
          taxRateBp: l.taxRateBp,
          taxPaise: l.taxPaise,
          totalPaise: l.totalPaise,
          discountPaise: l.discountPaise,
          hsnCode: l.hsnCode,
        })),
        payments,
      });

      setNotice({ kind: "ok", text: t("pos.saved", { number: created.number }) });
      // The bill that was resumed (if any) is now a real bill; drop the hold.
      if (heldItem) {
        await getRepository().takeHeldBill(heldItem.id);
        await refreshHeld();
      }
      resetBill(true);
      bumpDataVersion();
      if (print) requestPrint({ billId: created.billId, variant: "receipt-80" });
    } catch (err: unknown) {
      setNotice({
        kind: "error",
        text: t("pos.error.save_failed", { error: errMsg(err) }),
      });
    } finally {
      setBusy(false);
    }
  };

  const hold = async () => {
    if (lines.length === 0) return;
    setHeldError(null);
    try {
      await getRepository().saveHeldBill({
        label: `${formatQty(lines.reduce((s, l) => s + l.qtyMilli, 0))} item(s)`,
        customerId,
        lines: lines.map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli })),
      });
      resetBill();
      await refreshHeld();
    } catch (err: unknown) {
      setNotice({ kind: "error", text: errMsg(err) });
    }
  };

  const resume = async (id: number) => {
    setHeldError(null);
    try {
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
          hsnCode: item.hsnCode || undefined,
          discountPaise: 0,
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
    } catch (err: unknown) {
      setNotice({ kind: "error", text: errMsg(err) });
    }
  };

  const discardHeld = async (id: number) => {
    if (!window.confirm(t("pos.discard_confirm"))) return;
    try {
      await getRepository().takeHeldBill(id);
      if (heldItem?.id === id) setHeldItem(null);
      await refreshHeld();
    } catch (err: unknown) {
      setNotice({ kind: "error", text: errMsg(err) });
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "F2") {
      e.preventDefault();
      focusScan();
    } else if (e.key === "F4") {
      e.preventDefault();
      if (lines.length > 0) void hold();
    } else if (e.key === "F9") {
      e.preventDefault();
      if (lines.length > 0) void save(true);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] items-start" onKeyDown={onKeyDown}>
      <div className="min-w-0">
        <div className="relative mb-3 flex gap-2">
          <div className="relative flex-1">
            <input
              ref={scanRef}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder={t("pos.scan_ph")}
              data-testid="pos-scan"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  if (suggestions.length > 0) {
                    e.preventDefault();
                    setHighlightIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
                  }
                } else if (e.key === "ArrowUp") {
                  if (suggestions.length > 0) {
                    e.preventDefault();
                    setHighlightIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
                  }
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (highlightIndex >= 0 && suggestions[highlightIndex]) {
                    pickSuggestion(suggestions[highlightIndex]!);
                  } else {
                    void onScan(query);
                  }
                } else if (e.key === "Escape") {
                  setSuggestions([]);
                  setHighlightIndex(-1);
                }
              }}
            />

            {suggestions.length > 0 ? (
              <div
                ref={dropdownRef}
                data-testid="pos-suggestions"
                className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg"
              >
                {suggestions.map((item, idx) => (
                  <div
                    key={item.id}
                    data-testid={`pos-suggestion-${item.id}`}
                    className={`flex cursor-pointer items-center justify-between px-3 py-2 text-sm ${
                      idx === highlightIndex ? "bg-blue-50 text-blue-900" : "hover:bg-gray-50 text-gray-800"
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickSuggestion(item);
                    }}
                  >
                    <div>
                      <p className="font-medium">{item.name}</p>
                      {item.barcode ? (
                        <p className="text-xs text-gray-600 font-mono">{item.barcode}</p>
                      ) : null}
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-gray-900">₹{formatPaise(item.pricePaise)}</p>
                      <p className="text-xs text-gray-500">
                        {t("items.stock")}: {formatQty(item.stockMilli)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            disabled={busy || lines.length === 0}
            aria-disabled={busy || lines.length === 0}
            title={lines.length === 0 ? t("pos.cart_empty_tooltip") : t("pos.hold")}
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
          <EmptyState
            className="my-3 py-12"
            title={t("pos.empty")}
            hint={t("pos.empty_hint")}
          />
        ) : (
          <div className="overflow-x-auto min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left font-semibold text-gray-700">
                  <th className="px-3 py-2.5">{t("print.item")}</th>
                  <th className="px-3 py-2.5 text-right">{t("common.qty")}</th>
                  <th className="px-3 py-2.5 text-right">{t("common.price")}</th>
                  <th className="px-3 py-2.5 text-right">{t("pos.line_discount")}</th>
                  <th className="px-3 py-2.5 text-right">{t("common.total")}</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
            <tbody>
              {bill.lines.map((l, index) => {
                const line = lines[index]!;
                return (
                  <tr key={line.key} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900 flex items-center gap-1.5">
                        <span>{l.name}</span>
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 uppercase">
                          {line.unitKind === "weight" ? "kg" : line.unitKind === "volume" ? "L" : "pcs"}
                        </span>
                      </div>
                      {l.hsnCode ? (
                        <div className="text-xs text-gray-600 font-mono">HSN: {l.hsnCode}</div>
                      ) : null}
                      {line.batchNo && (
                        <div className="text-[11px] text-gray-500 font-mono">
                          Batch: {line.batchNo} {line.expiryDate ? `· Exp: ${line.expiryDate}` : ""}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          aria-label="Decrease quantity"
                          className="flex h-6 w-6 items-center justify-center rounded border border-gray-300 bg-gray-50 text-xs font-bold text-gray-700 hover:bg-gray-100"
                          onClick={() => stepQty(line.key, -1000)}
                        >
                          −
                        </button>
                        <input
                          key={`${line.key}-${l.qtyMilli}`}
                          className="w-16 rounded border border-gray-300 px-1.5 py-1 text-center text-sm font-medium"
                          data-testid={`pos-qty-${line.itemId}`}
                          defaultValue={formatQty(l.qtyMilli)}
                          onBlur={(e) => setQty(line.key, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              setQty(line.key, (e.target as HTMLInputElement).value);
                            }
                          }}
                        />
                        <button
                          type="button"
                          aria-label="Increase quantity"
                          className="flex h-6 w-6 items-center justify-center rounded border border-gray-300 bg-gray-50 text-xs font-bold text-gray-700 hover:bg-gray-100"
                          onClick={() => stepQty(line.key, 1000)}
                        >
                          +
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700">
                      {formatPaise(l.unitPricePaise)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        className="w-16 rounded border border-gray-300 px-2 py-1 text-right text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
                        placeholder="0"
                        data-testid={`pos-disc-${line.itemId}`}
                        defaultValue={line.discountPaise ? formatPaise(line.discountPaise) : ""}
                        onBlur={(e) => setLineDiscount(line.key, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            setLineDiscount(line.key, (e.target as HTMLInputElement).value);
                          }
                        }}
                      />
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-gray-900">
                      ₹{formatPaise(l.totalPaise)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="text-sm font-medium text-red-600 hover:text-red-800 hover:underline"
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
          </div>
        )}

        {heldError ? (
          <p className="mt-2 rounded bg-amber-50 px-3 py-1.5 text-xs text-amber-900" data-testid="pos-held-error">
            {heldError}
          </p>
        ) : null}
        <div className="mt-3" data-testid="pos-held">
          {held.length === 0 ? (
            <div className="flex items-center gap-2 px-1 text-xs text-gray-500">
              <span className="h-1.5 w-1.5 rounded-full bg-gray-300" />
              <span>{t("pos.resume_empty")}</span>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 bg-white p-2.5 shadow-xs">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-gray-700">{t("pos.resume")}</p>
                <span className="text-[11px] text-gray-500 font-medium">({held.length})</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {held.map((p) => (
                  <span key={p.id} className="inline-flex items-center rounded-md border border-gray-300 bg-gray-50 text-xs">
                    <button
                      type="button"
                      className="px-2.5 py-1 font-medium text-gray-800 hover:bg-gray-100"
                      data-testid={`pos-resume-${p.id}`}
                      onClick={() => void resume(p.id)}
                    >
                      {p.label} · {new Date(p.createdAt).toLocaleTimeString()}
                    </button>
                    <button
                      type="button"
                      className="border-l border-gray-300 px-2 py-1 text-red-600 hover:bg-red-50 font-bold"
                      aria-label={t("pos.discard")}
                      data-testid={`pos-discard-${p.id}`}
                      onClick={() => void discardHeld(p.id)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <aside className="flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)]">
        {/* Scrollable Configuration & Details Area */}
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {/* Section 1: Hero Total & Bill Breakdown */}
            <div>
              <div className="mb-2 rounded-lg bg-blue-50/80 p-2.5 border border-blue-100 text-center shadow-xs">
                <span className="text-[10px] uppercase font-bold tracking-wider text-blue-700">Total Payable</span>
                <div data-testid="pos-total" className="text-2xl font-black text-blue-900 tracking-tight mt-0.5">
                  ₹{formatPaise(bill.totalPaise)}
                </div>
                <p className="text-[11px] text-blue-600 mt-0.5 font-medium">
                  {lines.length} items ({formatQty(lines.reduce((s, l) => s + l.qtyMilli, 0))} units)
                </p>
              </div>

              <dl className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <dt className="text-gray-600">{t("pos.subtotal")}</dt>
                  <dd className="font-mono font-medium text-gray-900">{formatPaise(bill.subtotalPaise)}</dd>
                </div>

                <div className="flex items-center justify-between">
                  <dt className="text-gray-600">{t("pos.bill_discount")}</dt>
                  <dd>
                    <input
                      className="w-20 rounded border border-gray-300 px-2 py-0.5 text-right text-xs text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
                      placeholder="0"
                      data-testid="pos-bill-discount"
                      value={billDiscountStr}
                      onChange={(e) => setBillDiscountStr(e.target.value)}
                    />
                  </dd>
                </div>

                <div className="flex justify-between">
                  <dt className="text-gray-600">{t("pos.tax")}</dt>
                  <dd className="font-mono font-medium text-gray-900">{formatPaise(bill.taxPaise)}</dd>
                </div>

                <div className="flex items-center justify-between text-xs text-gray-600">
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      data-testid="pos-round-off-toggle"
                      checked={roundOffEnabled}
                      onChange={(e) => setRoundOffEnabled(e.target.checked)}
                    />
                    <span>{t("pos.round_off")}</span>
                  </label>
                  <span className="font-mono font-medium">
                    {bill.roundOffPaise !== 0
                      ? `${bill.roundOffPaise > 0 ? "+" : ""}₹${formatPaise(bill.roundOffPaise)}`
                      : "—"}
                  </span>
                </div>
              </dl>
            </div>

            <div className="border-t border-gray-200" />

            {/* Section 2: Payment Mode & Tenders */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700 mb-1">
                {t("pos.payment_mode")}
              </label>
              <div className="grid grid-cols-2 gap-1">
                {PAYMENT_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-testid={`pos-mode-${m}`}
                    className={`rounded-md border px-2 py-1.5 text-xs transition-colors ${
                      mode === m
                        ? "border-blue-600 bg-blue-50 text-blue-700 font-bold ring-1 ring-blue-600 shadow-xs"
                        : "border-gray-200 bg-white font-medium text-gray-700 hover:bg-gray-50"
                    }`}
                    onClick={() => {
                      setMode(m);
                      setTendered("");
                    }}
                  >
                    {t(`pos.mode.${m}` as I18nKey)}
                  </button>
                ))}
                <button
                  type="button"
                  data-testid="pos-mode-split"
                  className={`col-span-2 rounded-md border px-2 py-1.5 text-xs transition-colors ${
                    mode === "split"
                      ? "border-blue-600 bg-blue-50 text-blue-700 font-bold ring-1 ring-blue-600 shadow-xs"
                      : "border-gray-200 bg-white font-medium text-gray-700 hover:bg-gray-50"
                  }`}
                  onClick={() => setMode("split")}
                >
                  {t("pos.split_payment")}
                </button>
              </div>

              {mode === "cash" ? (
                <div className="mt-2.5 space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700">
                    {t("pos.tendered")}
                    <input
                      className="mt-1 w-full rounded-md border border-gray-300 px-2.5 py-1 text-sm font-mono shadow-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      data-testid="pos-tendered"
                      placeholder={formatPaise(bill.totalPaise)}
                      value={tendered}
                      onChange={(e) => setTendered(e.target.value)}
                    />
                  </label>

                  {/* Quick cash tender buttons in fixed 5-column grid */}
                  <div className="grid grid-cols-5 gap-1">
                    <button
                      type="button"
                      data-testid="pos-quick-exact"
                      className="rounded border border-gray-300 bg-gray-50 py-1 text-center text-xs font-semibold text-gray-700 hover:bg-gray-100 shadow-2xs"
                      onClick={() => setTendered(formatPaise(bill.totalPaise))}
                    >
                      {t("pos.exact")}
                    </button>
                    {[100, 200, 500, 2000].map((val) => (
                      <button
                        key={val}
                        type="button"
                        data-testid={`pos-quick-${val}`}
                        className="rounded border border-gray-300 bg-gray-50 py-1 text-center text-xs font-semibold text-gray-700 hover:bg-gray-100 shadow-2xs"
                        onClick={() => setTendered(String(val))}
                      >
                        ₹{val}
                      </button>
                    ))}
                  </div>

                  {change > 0 ? (
                    <div
                      data-testid="pos-change-banner"
                      className="rounded-lg bg-green-50 p-2 text-center border border-green-200"
                    >
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-green-700">
                        {t("pos.change_due")}
                      </p>
                      <p className="text-xl font-black text-green-800">₹{formatPaise(change)}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {mode === "upi" ? (
                <div className="mt-2.5 rounded-xl border border-blue-200 bg-blue-50/50 p-2.5 flex flex-col items-center">
                  <UpiQrCode
                    vpa={profile?.phone ? `${profile.phone.replace(/[^0-9]/g, "")}@upi` : "store@upi"}
                    payeeName={profile?.name || "Store"}
                    amountPaise={bill.totalPaise}
                    size={130}
                  />
                </div>
              ) : null}

              {mode === "split" ? (
                <div className="mt-2.5 rounded-lg border border-gray-200 bg-gray-50 p-2 shadow-xs" data-testid="pos-split-form">
                  <p className="mb-1.5 text-xs font-semibold text-gray-700">{t("pos.split_hint")}</p>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-700">{t("pos.mode.cash")}</span>
                      <input
                        type="number"
                        step="0.01"
                        className="w-24 rounded border border-gray-300 bg-white px-2 py-0.5 text-right text-xs"
                        placeholder="0"
                        data-testid="pos-split-cash"
                        value={splitAmounts.cash}
                        onChange={(e) => setSplitAmounts((s) => ({ ...s, cash: e.target.value }))}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-700">{t("pos.mode.upi")}</span>
                      <input
                        type="number"
                        step="0.01"
                        className="w-24 rounded border border-gray-300 bg-white px-2 py-0.5 text-right text-xs"
                        placeholder="0"
                        data-testid="pos-split-upi"
                        value={splitAmounts.upi}
                        onChange={(e) => setSplitAmounts((s) => ({ ...s, upi: e.target.value }))}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-700">{t("pos.mode.card")}</span>
                      <input
                        type="number"
                        step="0.01"
                        className="w-24 rounded border border-gray-300 bg-white px-2 py-0.5 text-right text-xs"
                        placeholder="0"
                        data-testid="pos-split-card"
                        value={splitAmounts.card}
                        onChange={(e) => setSplitAmounts((s) => ({ ...s, card: e.target.value }))}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-700">{t("pos.mode.credit")}</span>
                      <input
                        type="number"
                        step="0.01"
                        className="w-24 rounded border border-gray-300 bg-white px-2 py-0.5 text-right text-xs"
                        placeholder="0"
                        data-testid="pos-split-credit"
                        value={splitAmounts.credit}
                        onChange={(e) => setSplitAmounts((s) => ({ ...s, credit: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="mt-1.5 border-t border-gray-200 pt-1 flex justify-between text-xs font-semibold">
                    <span className="text-gray-700">Paid:</span>
                    <span
                      className={
                        payments.reduce((s, p) => s + p.amountPaise, 0) === bill.totalPaise
                          ? "text-green-700"
                          : "text-red-600"
                      }
                    >
                      ₹{formatPaise(payments.reduce((s, p) => s + p.amountPaise, 0))} / ₹
                      {formatPaise(bill.totalPaise)}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="border-t border-gray-200" />

            {/* Section 3: Customer & Loyalty */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700">
                {t("pos.customer")}
                <select
                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs shadow-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-normal"
                  data-testid="pos-customer"
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

              {customerId && customerLoyaltyBalance > 0 && (
                <div className="mt-2 rounded-lg border border-purple-200 bg-purple-50 p-2 text-xs shadow-xs" data-testid="pos-loyalty-panel">
                  <div className="flex items-center justify-between text-purple-900 font-medium">
                    <span>Loyalty Points:</span>
                    <span className="font-bold text-xs font-mono" data-testid="pos-loyalty-balance">{customerLoyaltyBalance} pts</span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between text-[11px] text-purple-700">
                    <span>Value: ₹{formatPaise(customerLoyaltyBalance * DEFAULT_LOYALTY_CONFIG.pointValuePaise)}</span>
                    {redeemedPoints > 0 ? (
                      <button
                        type="button"
                        data-testid="pos-loyalty-cancel"
                        className="text-red-600 hover:underline font-semibold"
                        onClick={() => setRedeemedPoints(0)}
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid="pos-loyalty-redeem"
                        className="rounded bg-purple-600 px-2 py-0.5 font-bold text-white hover:bg-purple-700 shadow-xs"
                        onClick={() => {
                          const maxRedeem = Math.min(
                            customerLoyaltyBalance,
                            Math.floor(bill.subtotalPaise / DEFAULT_LOYALTY_CONFIG.pointValuePaise),
                          );
                          setRedeemedPoints(maxRedeem);
                        }}
                      >
                        Redeem
                      </button>
                    )}
                  </div>
                  {redeemedPoints > 0 && (
                    <div className="mt-0.5 font-semibold text-green-700 text-[11px]" data-testid="pos-loyalty-applied">
                      Redeeming {redeemedPoints} pts (-₹{formatPaise(loyaltyDiscountPaise)})
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Subtle scroll hint fade at bottom of details area */}
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-4 bg-gradient-to-t from-gray-200/40 to-transparent" />
        </div>

        {/* Sticky Primary Footer */}
        <div className="border-t border-gray-200 bg-gray-50/90 backdrop-blur-xs p-3 space-y-1.5 shrink-0">
          <button
            type="button"
            data-testid="pos-save-print"
            disabled={busy || lines.length === 0}
            aria-disabled={busy || lines.length === 0}
            title={lines.length === 0 ? t("pos.cart_empty_tooltip") : "Save & print (F9)"}
            className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            onClick={() => void save(true)}
          >
            {t("pos.save_print")}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || lines.length === 0}
              aria-disabled={busy || lines.length === 0}
              title={lines.length === 0 ? t("pos.cart_empty_tooltip") : t("pos.save")}
              data-testid="pos-save"
              className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              onClick={() => void save(false)}
            >
              {t("pos.save")}
            </button>
            <button
              type="button"
              data-testid="pos-clear"
              className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50 transition-colors"
              onClick={() => resetBill()}
            >
              {t("pos.clear")}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
