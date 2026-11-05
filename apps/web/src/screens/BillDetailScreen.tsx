// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { formatPaise, formatQty, splitGst, validateVoidReason } from "@mytowncart-billing/core";
import type { BillDetail } from "@mytowncart-billing/storage";
import { t, type I18nKey } from "../i18n";
import { paymentModeLabel } from "../lib/labels";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

export function BillDetailScreen() {
  const { id } = useParams();
  const billId = Number(id);
  const requestPrint = useAppStore((s) => s.requestPrint);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);
  const dataVersion = useAppStore((s) => s.dataVersion);

  const [bill, setBill] = useState<BillDetail | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [voidError, setVoidError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getRepository()
      .getBill(billId)
      .then((detail) => {
        if (!cancelled) setBill(detail);
      });
    return () => {
      cancelled = true;
    };
  }, [billId, dataVersion]);

  if (!bill) {
    return <p className="text-sm text-gray-500">{t("common.loading")}</p>;
  }

  const tax = splitGst(bill.taxPaise);

  const onVoid = async () => {
    const problem = validateVoidReason(reason);
    if (problem) {
      setVoidError(t("bill.void_reason_ph"));
      return;
    }
    await getRepository().voidBill(bill.id, reason.trim());
    setVoiding(false);
    setReason("");
    bumpDataVersion();
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold">{t("bill.title", { number: bill.number })}</h1>
        <Link to="/bills" className="text-sm text-blue-600 hover:underline">
          {t("common.back")}
        </Link>
      </div>

      <div className="mb-4 rounded border border-gray-200 bg-white p-4 text-sm">
        <div className="flex flex-wrap gap-x-8 gap-y-1 text-gray-600">
          <span>{new Date(bill.createdAt).toLocaleString()}</span>
          <span>{t("bill.fy", { fy: bill.fy })}</span>
          <span>
            {t("bills.status")}: {t(`bills.status.${bill.status}` as I18nKey)}
          </span>
          {bill.customerName ? (
            <span>
              {t("bills.customer")}: {bill.customerName}
            </span>
          ) : null}
        </div>
        {bill.status === "void" && bill.voidedAt ? (
          <p className="mt-2 rounded bg-red-50 px-2 py-1 text-red-700" data-testid="bill-voided">
            {t("bill.voided", {
              date: new Date(bill.voidedAt).toLocaleString(),
              reason: bill.voidReason ?? "",
            })}
          </p>
        ) : null}
      </div>

      <table className="mb-4 w-full rounded border border-gray-200 bg-white text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-500">
            <th className="px-3 py-2">{t("print.item")}</th>
            <th className="px-3 py-2 text-right">{t("common.qty")}</th>
            <th className="px-3 py-2 text-right">{t("common.price")}</th>
            <th className="px-3 py-2 text-right">{t("pos.tax")}</th>
            <th className="px-3 py-2 text-right">{t("common.total")}</th>
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((l) => (
            <tr key={l.id} className="border-b border-gray-100 last:border-0">
              <td className="px-3 py-2 font-medium">{l.nameSnapshot}</td>
              <td className="px-3 py-2 text-right">{formatQty(l.qtyMilli)}</td>
              <td className="px-3 py-2 text-right">{formatPaise(l.unitPricePaise)}</td>
              <td className="px-3 py-2 text-right">{formatPaise(l.taxPaise)}</td>
              <td className="px-3 py-2 text-right">{formatPaise(l.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mb-4 flex justify-end">
        <table className="w-72 rounded border border-gray-200 bg-white p-3 text-sm">
          <tbody>
            <tr>
              <td>{t("pos.subtotal")}</td>
              <td className="text-right">{formatPaise(bill.subtotalPaise)}</td>
            </tr>
            {bill.taxPaise > 0 ? (
              <>
                <tr>
                  <td>{t("print.cgst")}</td>
                  <td className="text-right">{formatPaise(tax.cgstPaise)}</td>
                </tr>
                <tr>
                  <td>{t("print.sgst")}</td>
                  <td className="text-right">{formatPaise(tax.sgstPaise)}</td>
                </tr>
              </>
            ) : null}
            <tr className="font-bold">
              <td className="pt-1">{t("pos.total")}</td>
              <td className="pt-1 text-right" data-testid="bill-total">
                ₹{formatPaise(bill.totalPaise)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mb-4 text-sm text-gray-600">
        {t("bill.payments")}:{" "}
        {bill.payments
          .map((p) => `${paymentModeLabel(p.mode)} ${formatPaise(p.amountPaise)}`)
          .join(" · ")}
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="bill-print-receipt"
          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
          onClick={() => requestPrint({ billId: bill.id, variant: "receipt-80" })}
        >
          {t("bill.reprint_receipt")}
        </button>
        <button
          type="button"
          data-testid="bill-print-invoice"
          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
          onClick={() => requestPrint({ billId: bill.id, variant: "invoice-a4" })}
        >
          {t("bill.print_invoice")}
        </button>
        {bill.status === "active" ? (
          <button
            type="button"
            data-testid="bill-void"
            className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
            onClick={() => setVoiding(true)}
          >
            {t("bill.void")}
          </button>
        ) : null}
      </div>

      {voiding ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-sm rounded bg-white p-4 shadow-lg" data-testid="void-dialog">
            <h2 className="mb-2 font-semibold">{t("bill.void")}</h2>
            <p className="mb-3 text-sm text-gray-600">
              A bill is never edited. Voiding writes a compensating stock movement and keeps
              this record.
            </p>
            <textarea
              autoFocus
              rows={3}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              placeholder={t("bill.void_reason_ph")}
              data-testid="void-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {voidError ? <p className="mt-2 text-sm text-red-600">{voidError}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-gray-300 px-3 py-1.5 text-sm"
                onClick={() => setVoiding(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                data-testid="void-confirm"
                className="rounded bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700"
                onClick={() => void onVoid()}
              >
                {t("bill.void_confirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
