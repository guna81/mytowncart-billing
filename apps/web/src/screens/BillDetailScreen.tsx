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
import { Money, PageHeader, Badge } from "../components/ui";
import { t, type I18nKey } from "../i18n";
import { paymentModeLabel } from "../lib/labels";
import { getRepository } from "../lib/repository";
import { useIsOwner } from "../lib/roles";
import { formatDateTime } from "../lib/formatDate";
import { useAppStore } from "../store/appStore";

export function BillDetailScreen() {
  const isOwner = useIsOwner();
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
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader
        title={t("bill.title", { number: bill.number })}
        subtitle={formatDateTime(bill.createdAt)}
        actions={
          <Link
            to="/bills"
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50 transition-colors"
          >
            ← {t("common.back")}
          </Link>
        }
      />

      {/* Bill Metadata Card */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-700">
            <div>
              <span className="text-gray-500 font-medium">Date: </span>
              <span className="font-semibold">{formatDateTime(bill.createdAt)}</span>
            </div>
            <div>
              <span className="text-gray-500 font-medium">FY: </span>
              <span className="font-semibold">{bill.fy}</span>
            </div>
            {bill.customerName ? (
              <div>
                <span className="text-gray-500 font-medium">{t("bills.customer")}: </span>
                <span className="font-semibold">{bill.customerName}</span>
              </div>
            ) : null}
          </div>
          <div>
            <Badge variant={bill.status === "void" ? "red" : "green"}>
              {t(`bills.status.${bill.status}` as I18nKey)}
            </Badge>
          </div>
        </div>

        {bill.status === "void" && bill.voidedAt ? (
          <p className="mt-3 rounded-lg bg-red-50 p-2.5 text-sm font-medium text-red-700 border border-red-200" data-testid="bill-voided">
            {t("bill.voided", {
              date: formatDateTime(bill.voidedAt),
              reason: bill.voidReason ?? "",
            })}
          </p>
        ) : null}
      </div>

      {/* Items Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left font-semibold text-gray-700">
              <th className="px-3 py-2.5">{t("print.item")}</th>
              <th className="px-3 py-2.5 text-right">{t("common.qty")}</th>
              <th className="px-3 py-2.5 text-right">{t("common.price")}</th>
              <th className="px-3 py-2.5 text-right">{t("pos.line_discount")}</th>
              <th className="px-3 py-2.5 text-right">{t("pos.tax")}</th>
              <th className="px-3 py-2.5 text-right">{t("common.total")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {bill.lines.map((l) => (
              <tr key={l.id} className="hover:bg-gray-50">
                <td className="px-3 py-2.5 font-medium text-gray-900">
                  {l.nameSnapshot}
                  {l.hsnCode ? <span className="ml-1 text-xs text-gray-600 font-mono">(HSN: {l.hsnCode})</span> : null}
                </td>
                <td className="px-3 py-2.5 text-right text-gray-700 font-mono">{formatQty(l.qtyMilli)}</td>
                <td className="px-3 py-2.5 text-right text-gray-700 font-mono">₹{formatPaise(l.unitPricePaise)}</td>
                <td className="px-3 py-2.5 text-right text-gray-600 font-mono">
                  {l.discountPaise > 0 ? `₹${formatPaise(l.discountPaise)}` : "—"}
                </td>
                <td className="px-3 py-2.5 text-right text-gray-700 font-mono">₹{formatPaise(l.taxPaise)}</td>
                <td className="px-3 py-2.5 text-right font-semibold text-gray-900 font-mono">₹{formatPaise(l.totalPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Totals Summary */}
      <div className="flex justify-end">
        <div className="w-80 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-600">{t("pos.subtotal")}</dt>
              <dd className="font-mono font-medium text-gray-900">₹{formatPaise(bill.subtotalPaise)}</dd>
            </div>
            {bill.discountPaise > 0 ? (
              <div className="flex justify-between text-green-700">
                <dt>{t("pos.bill_discount")}</dt>
                <dd className="font-mono font-medium">-₹{formatPaise(bill.discountPaise)}</dd>
              </div>
            ) : null}
            {bill.taxPaise > 0 ? (
              <>
                <div className="flex justify-between text-gray-600 text-xs">
                  <dt>{t("print.cgst")}</dt>
                  <dd className="font-mono">₹{formatPaise(tax.cgstPaise)}</dd>
                </div>
                <div className="flex justify-between text-gray-600 text-xs">
                  <dt>{t("print.sgst")}</dt>
                  <dd className="font-mono">₹{formatPaise(tax.sgstPaise)}</dd>
                </div>
              </>
            ) : null}
            {bill.roundOffPaise !== 0 ? (
              <div className="flex justify-between text-gray-600 text-xs">
                <dt>{t("pos.round_off")}</dt>
                <dd className="font-mono">
                  {bill.roundOffPaise > 0 ? "+" : ""}₹{formatPaise(bill.roundOffPaise)}
                </dd>
              </div>
            ) : null}
            <div className="border-t border-gray-200 pt-2 flex justify-between items-baseline font-bold">
              <dt className="text-base text-gray-900">{t("pos.total")}</dt>
              <dd className="text-2xl font-black text-blue-900 font-mono tracking-tight" data-testid="bill-total">
                ₹{formatPaise(bill.totalPaise)}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Payment Breakdown as Labelled Rows */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-700 mb-2">
          {t("bill.payments")}
        </h3>
        <div className="flex flex-wrap gap-2.5">
          {bill.payments.map((p, idx) => (
            <div key={idx} className="flex items-center gap-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-1.5 text-sm">
              <span className="font-medium text-gray-700">{paymentModeLabel(p.mode)}:</span>
              <span className="font-bold text-gray-900">₹{formatPaise(p.amountPaise)}</span>
            </div>
          ))}
        </div>
      </div>

      {notice ? (
        <div className="rounded-xl bg-green-50 p-3 text-sm font-semibold text-green-800 border border-green-200" data-testid="bill-notice">
          {notice}
        </div>
      ) : null}

      {/* Action Buttons: Primary Print, Secondary Return, Separated Destructive Void */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-gray-200">
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            data-testid="bill-print-receipt"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 transition-colors"
            onClick={() => requestPrint({ billId: bill.id, variant: "receipt-80" })}
          >
            🖨️ {t("bill.reprint_receipt")}
          </button>
          <button
            type="button"
            data-testid="bill-print-invoice"
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50 transition-colors"
            onClick={() => requestPrint({ billId: bill.id, variant: "invoice-a4" })}
          >
            📄 {t("bill.print_invoice")}
          </button>
          {bill.status === "active" ? (
            <button
              type="button"
              data-testid="bill-return"
              className="rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-sm font-semibold text-amber-800 shadow-sm hover:bg-amber-100 transition-colors"
              onClick={() => setReturning(true)}
            >
              ↩ {t("returns.btn")}
            </button>
          ) : null}
          {customer?.phone || bill.customerName ? (
            <button
              type="button"
              data-testid="bill-share-whatsapp"
              className="rounded-lg border border-emerald-300 bg-emerald-50 px-3.5 py-2 text-sm font-semibold text-emerald-800 shadow-sm hover:bg-emerald-100 transition-colors"
              onClick={() => {
                const phone = customer?.phone || "";
                const msg = `Bill ${bill.number} from ${profile?.name || "Store"}. Total: ₹${formatPaise(bill.totalPaise)}. Thank you for shopping with us!`;
                const url = generateWhatsAppBillShareUrl(phone, msg);
                window.open(url, "_blank");
              }}
            >
              💬 {t("bill.share_whatsapp")}
            </button>
          ) : null}
        </div>

        {bill.status === "active" && isOwner ? (
          <div>
            <button
              type="button"
              data-testid="bill-void"
              className="rounded-lg border border-red-300 bg-white px-3.5 py-2 text-sm font-semibold text-red-600 shadow-sm hover:bg-red-50 hover:border-red-400 transition-colors"
              onClick={() => setVoiding(true)}
            >
              ✕ {t("bill.void")}
            </button>
          </div>
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
