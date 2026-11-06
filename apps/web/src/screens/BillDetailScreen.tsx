// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  formatPaise,
  formatQty,
  generateWhatsAppBillShareUrl,
  splitGst,
  validateVoidReason,
} from "@mytowncart-billing/core";
import type { BillDetail, CreditNote, Customer } from "@mytowncart-billing/storage";
import { CreditNoteModal } from "../components/CreditNoteModal";
import { Money } from "../components/ui";
import { t, type I18nKey } from "../i18n";
import { paymentModeLabel } from "../lib/labels";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

export function BillDetailScreen() {
  const { id } = useParams();
  const billId = Number(id);
  const profile = useAppStore((s) => s.profile);
  const requestPrint = useAppStore((s) => s.requestPrint);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);
  const dataVersion = useAppStore((s) => s.dataVersion);

  const [bill, setBill] = useState<BillDetail | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
  const [voiding, setVoiding] = useState(false);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  const [voidError, setVoidError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getRepository()
      .getBill(billId)
      .then((detail) => {
        if (!cancelled && detail) {
          setBill(detail);
          if (detail.customerId) {
            void getRepository().listCustomers().then((custs) => {
              const c = custs.find((x) => x.id === detail.customerId);
              if (!cancelled && c) setCustomer(c);
            });
          }
        }
      });

    void getRepository()
      .listCreditNotes(billId)
      .then((notes) => {
        if (!cancelled) setCreditNotes(notes);
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
            <th className="px-3 py-2 text-right">{t("pos.line_discount")}</th>
            <th className="px-3 py-2 text-right">{t("pos.tax")}</th>
            <th className="px-3 py-2 text-right">{t("common.total")}</th>
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((l) => (
            <tr key={l.id} className="border-b border-gray-100 last:border-0">
              <td className="px-3 py-2 font-medium">
                {l.nameSnapshot}
                {l.hsnCode ? <span className="ml-1 text-xs text-gray-400 font-mono">(HSN: {l.hsnCode})</span> : null}
              </td>
              <td className="px-3 py-2 text-right">{formatQty(l.qtyMilli)}</td>
              <td className="px-3 py-2 text-right">{formatPaise(l.unitPricePaise)}</td>
              <td className="px-3 py-2 text-right text-amber-700">
                {l.discountPaise > 0 ? formatPaise(l.discountPaise) : "—"}
              </td>
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
            {bill.discountPaise > 0 ? (
              <tr>
                <td>{t("pos.bill_discount")}</td>
                <td className="text-right text-amber-700">-₹{formatPaise(bill.discountPaise)}</td>
              </tr>
            ) : null}
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
            {bill.roundOffPaise !== 0 ? (
              <tr>
                <td>{t("pos.round_off")}</td>
                <td className="text-right">
                  {bill.roundOffPaise > 0 ? "+" : ""}₹{formatPaise(bill.roundOffPaise)}
                </td>
              </tr>
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

      {notice ? (
        <div className="mb-4 rounded-md bg-green-50 p-3 text-sm text-green-800 border border-green-200" data-testid="bill-notice">
          {notice}
        </div>
      ) : null}

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
          <>
            <button
              type="button"
              data-testid="bill-return"
              className="rounded border border-amber-400 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
              onClick={() => setReturning(true)}
            >
              {t("returns.btn")}
            </button>
            <button
              type="button"
              data-testid="bill-void"
              className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
              onClick={() => setVoiding(true)}
            >
              {t("bill.void")}
            </button>
          </>
        ) : null}
        {customer?.phone || bill.customerName ? (
          <button
            type="button"
            data-testid="bill-share-whatsapp"
            className="rounded border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
            onClick={() => {
              const phone = customer?.phone || "";
              const msg = `Bill ${bill.number} from ${profile?.name || "Store"}. Total: ₹${formatPaise(bill.totalPaise)}. Thank you for shopping with us!`;
              const url = generateWhatsAppBillShareUrl(phone, msg);
              window.open(url, "_blank");
            }}
          >
            {t("bill.share_whatsapp")}
          </button>
        ) : null}
      </div>

      {creditNotes.length > 0 ? (
        <div className="mt-6 rounded border border-amber-200 bg-amber-50/40 p-4" data-testid="credit-notes-section">
          <h3 className="font-semibold text-gray-800 mb-2">{t("returns.credit_notes_history")}</h3>
          <div className="space-y-2">
            {creditNotes.map((cn) => (
              <div
                key={cn.id}
                className="flex items-center justify-between bg-white border border-gray-200 rounded p-2.5 text-sm"
              >
                <div>
                  <span className="font-mono font-bold text-gray-800 mr-2">{cn.number}</span>
                  <span className="text-gray-500 text-xs mr-2">
                    {new Date(cn.createdAt).toLocaleString()}
                  </span>
                  <span className="text-gray-600 text-xs italic">({cn.reason})</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-red-600">
                    -<Money paise={cn.totalPaise} />
                  </span>
                  <button
                    type="button"
                    className="text-xs text-blue-600 hover:underline border border-blue-200 rounded px-2 py-1"
                    data-testid={`print-cn-${cn.id}`}
                    onClick={() => requestPrint({ creditNoteId: cn.id, variant: "credit-note-80" })}
                  >
                    {t("returns.print_cn")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <CreditNoteModal
        bill={bill}
        isOpen={returning}
        onClose={() => setReturning(false)}
        onSuccess={(_cnId, number) => {
          setNotice(t("returns.success", { number }));
          bumpDataVersion();
        }}
      />

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
