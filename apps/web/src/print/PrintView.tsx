// SPDX-License-Identifier: Apache-2.0
/**
 * Receipt/invoice printing (roadmap §8.9): browser print of a 58/80 mm
 * receipt template or an A4 invoice. The document is rendered into
 * `.print-area`; while a print job is active the app shell hides (see
 * styles.css) and `window.print()` opens the system dialog.
 */
import { useCallback, useEffect, useState } from "react";

import {
  aggregateTaxByRate,
  amountInWords,
  formatPaise,
  formatQty,
  splitGst,
} from "@mytowncart-billing/core";
import type { BillDetail, CreditNote, Customer, DayEndClosure, ShopProfile } from "@mytowncart-billing/storage";
import { UpiQrCode } from "../components/UpiQrCode";
import { t } from "../i18n";
import { paymentModeLabel } from "../lib/labels";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

function ReceiptDoc({
  bill,
  customer,
  profile,
  logo,
}: {
  bill: BillDetail;
  customer: Customer | null;
  profile: ShopProfile | null;
  logo?: string | null;
}) {
  const tax = splitGst(bill.taxPaise);
  const showGst = profile?.gstEnabled && bill.taxPaise > 0;

  return (
    <div className="font-mono text-xs leading-tight">
      {logo ? (
        <div className="flex justify-center mb-1.5">
          <img src={logo} alt="" className="h-10 max-w-[120px] object-contain grayscale" />
        </div>
      ) : null}
      <p className="text-center font-bold text-sm">{profile?.name ?? ""}</p>
      {profile?.address ? <p className="text-center">{profile.address}</p> : null}
      {profile?.phone ? <p className="text-center">{profile.phone}</p> : null}
      {profile?.gstin ? <p className="text-center">GSTIN {profile.gstin}</p> : null}
      <hr className="border-dashed my-1" />
      <p>
        {bill.number} · {new Date(bill.createdAt).toLocaleString()}
        {bill.status === "void" ? ` · ${t("print.void_copy")}` : ""}
      </p>
      {customer || bill.customerName ? (
        <p className="text-gray-700">
          {t("bills.customer")}: {customer?.name ?? bill.customerName}
          {customer?.phone ? ` (${customer.phone})` : ""}
        </p>
      ) : null}
      <hr className="border-dashed my-1" />
      <table className="w-full">
        <tbody>
          {bill.lines.map((l) => (
            <tr key={l.id}>
              <td className="align-top pr-1">
                {l.nameSnapshot}
                {l.hsnCode ? <span className="text-gray-600"> (HSN: {l.hsnCode})</span> : null}
                <br />
                <span className="text-gray-500">
                  {formatQty(l.qtyMilli)} × {formatPaise(l.unitPricePaise)}
                  {l.discountPaise > 0 ? ` [Disc -₹${formatPaise(l.discountPaise)}]` : ""}
                </span>
              </td>
              <td className="text-right align-top">{formatPaise(l.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <hr className="border-dashed my-1" />
      <table className="w-full">
        <tbody>
          <tr>
            <td>{t("pos.subtotal")}</td>
            <td className="text-right">{formatPaise(bill.subtotalPaise)}</td>
          </tr>
          {bill.discountPaise > 0 ? (
            <tr>
              <td>{t("pos.bill_discount")}</td>
              <td className="text-right">-₹{formatPaise(bill.discountPaise)}</td>
            </tr>
          ) : null}
          {showGst ? (
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
          <tr className="font-bold text-sm">
            <td>{t("pos.total")}</td>
            <td className="text-right">₹{formatPaise(bill.totalPaise)}</td>
          </tr>
          {bill.payments.map((p) => (
            <tr key={p.id}>
              <td>{paymentModeLabel(p.mode)}</td>
              <td className="text-right">{formatPaise(p.amountPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {customer && customer.loyaltyPoints !== undefined && (
        <div className="my-1 border-t border-dashed pt-1 text-center font-bold text-gray-800">
          Loyalty Points: {customer.loyaltyPoints} pts
        </div>
      )}
      {profile?.receiptFooter ? <p className="text-center mt-2">{profile.receiptFooter}</p> : null}
      {profile?.phone ? (
        <div className="mt-3 flex justify-center">
          <UpiQrCode
            vpa={`${profile.phone.replace(/[^0-9]/g, "")}@upi`}
            payeeName={profile.name || "Store"}
            amountPaise={bill.totalPaise}
            transactionNote={bill.number}
            size={110}
          />
        </div>
      ) : null}
      <p className="text-center mt-2">{t("print.thank_you")}</p>
    </div>
  );
}

function CreditNoteDoc({
  creditNote,
  profile,
}: {
  creditNote: CreditNote;
  profile: ShopProfile | null;
}) {
  return (
    <div className="font-mono text-xs leading-tight max-w-lg mx-auto" data-testid="credit-note-doc">
      <p className="text-center font-bold text-sm">{profile?.name ?? "Store"}</p>
      {profile?.address ? <p className="text-center">{profile.address}</p> : null}
      {profile?.phone ? <p className="text-center">{profile.phone}</p> : null}
      {profile?.gstin ? <p className="text-center">GSTIN {profile.gstin}</p> : null}
      <hr className="border-dashed my-2" />
      <div className="text-center font-bold text-sm tracking-wider uppercase bg-gray-100 py-1 rounded">
        {t("print.credit_note")}
      </div>
      <div className="mt-2 flex justify-between text-gray-700">
        <span>CN No: <strong>{creditNote.number}</strong></span>
        <span>Date: {new Date(creditNote.createdAt).toLocaleDateString()}</span>
      </div>
      <div className="text-gray-600 text-[11px] mt-1">
        Reason: <span className="italic">{creditNote.reason}</span>
      </div>
      <hr className="border-dashed my-2" />
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-gray-300">
            <th className="py-1">{t("print.item")}</th>
            <th className="py-1 text-right">{t("common.qty")}</th>
            <th className="py-1 text-right">{t("common.price")}</th>
            <th className="py-1 text-right">{t("common.total")}</th>
          </tr>
        </thead>
        <tbody>
          {creditNote.lines.map((l) => (
            <tr key={l.id} className="border-b border-gray-100">
              <td className="py-1 font-medium">{l.nameSnapshot}</td>
              <td className="py-1 text-right">{formatQty(l.qtyMilli)}</td>
              <td className="py-1 text-right">{formatPaise(l.unitPricePaise)}</td>
              <td className="py-1 text-right">{formatPaise(l.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex justify-end font-bold text-sm">
        <span>Total Refund / Credit: ₹{formatPaise(creditNote.totalPaise)}</span>
      </div>
      <p className="mt-2 text-[11px] text-gray-500 italic">
        {amountInWords(creditNote.totalPaise)}
      </p>
      <div className="mt-8 pt-4 border-t border-gray-300 flex justify-between items-end">
        <span className="text-xs text-gray-600">Computer-generated document</span>
        <div className="text-center">
          <div className="w-32 border-b border-gray-400 mb-1" />
          <span className="text-[10px] text-gray-600">{t("print.authorised_signatory")}</span>
        </div>
      </div>
    </div>
  );
}

function InvoiceDoc({
  bill,
  customer,
  profile,
  logo,
}: {
  bill: BillDetail;
  customer: Customer | null;
  profile: ShopProfile | null;
  logo?: string | null;
}) {
  const tax = splitGst(bill.taxPaise);
  const isGst = profile?.gstEnabled ?? false;
  const docTitle = isGst ? t("print.invoice") : t("print.bill_of_supply");
  const hasAnyDiscount = bill.lines.some((l) => l.discountPaise > 0);

  // Per-rate GST summary
  const taxLinesInput = bill.lines.map((l) => {
    const lineGst = splitGst(l.taxPaise);
    return {
      netPaise: l.totalPaise - l.taxPaise,
      taxRateBp: l.taxRateBp,
      taxPaise: l.taxPaise,
      cgstPaise: lineGst.cgstPaise,
      sgstPaise: lineGst.sgstPaise,
    };
  });
  const taxRateBreakdown = isGst ? aggregateTaxByRate(taxLinesInput) : [];

  return (
    <div className="text-sm">
      <div className="flex justify-between items-start mb-6">
        <div className="flex items-start gap-3">
          {logo ? (
            <img src={logo} alt="" className="h-14 w-14 object-contain rounded border border-gray-200 p-0.5" />
          ) : null}
          <div>
            <h1 className="text-xl font-bold">{profile?.name ?? ""}</h1>
            {profile?.address ? <p>{profile.address}</p> : null}
            {profile?.phone ? <p>{profile.phone}</p> : null}
            {profile?.gstin ? <p>GSTIN: {profile.gstin}</p> : null}
          </div>
        </div>
        <div className="text-right">
          <h2 className="text-lg font-semibold">{docTitle}</h2>
          <p className="font-mono">{bill.number}</p>
          <p>{new Date(bill.createdAt).toLocaleString()}</p>
          <p>{t("bill.fy", { fy: bill.fy })}</p>
          {bill.status === "void" ? (
            <p className="font-bold text-red-600">{t("print.void_copy")}</p>
          ) : null}
        </div>
      </div>

      {customer || bill.customerName ? (
        <div className="mb-4 rounded border border-gray-200 p-3 bg-gray-50/50">
          <p className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">
            {t("print.buyer")}
          </p>
          <p className="font-semibold text-gray-900">{customer?.name ?? bill.customerName}</p>
          {customer?.phone ? (
            <p className="text-xs text-gray-600">
              {t("common.phone")}: {customer.phone}
            </p>
          ) : null}
          {customer?.gstin ? (
            <p className="text-xs font-mono text-gray-700">
              {t("customers.gstin")}: {customer.gstin}
            </p>
          ) : null}
          {customer?.address ? (
            <p className="text-xs text-gray-600 whitespace-pre-line">{customer.address}</p>
          ) : null}
        </div>
      ) : null}

      <table className="w-full border-collapse mb-4 text-xs">
        <thead>
          <tr className="border-b-2 border-gray-800 text-left font-semibold text-gray-700">
            <th className="py-1.5">{t("print.item")}</th>
            <th className="py-1.5">{t("print.hsn")}</th>
            <th className="py-1.5 text-right">{t("common.qty")}</th>
            <th className="py-1.5 text-right">{t("print.rate")}</th>
            {hasAnyDiscount ? (
              <th className="py-1.5 text-right">{t("pos.line_discount")}</th>
            ) : null}
            <th className="py-1.5 text-right">{t("print.taxable_value")}</th>
            {isGst ? (
              <>
                <th className="py-1.5 text-right">{t("print.cgst")}</th>
                <th className="py-1.5 text-right">{t("print.sgst")}</th>
              </>
            ) : null}
            <th className="py-1.5 text-right">{t("common.total")}</th>
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((l) => {
            const lineGst = splitGst(l.taxPaise);
            const taxablePaise = l.totalPaise - l.taxPaise;
            return (
              <tr key={l.id} className="border-b border-gray-200">
                <td className="py-1.5 font-medium text-gray-900">{l.nameSnapshot}</td>
                <td className="py-1.5 font-mono text-gray-600">{l.hsnCode || "—"}</td>
                <td className="py-1.5 text-right">{formatQty(l.qtyMilli)}</td>
                <td className="py-1.5 text-right font-mono">{formatPaise(l.unitPricePaise)}</td>
                {hasAnyDiscount ? (
                  <td className="py-1.5 text-right font-mono text-amber-700">
                    {l.discountPaise > 0 ? formatPaise(l.discountPaise) : "—"}
                  </td>
                ) : null}
                <td className="py-1.5 text-right font-mono">{formatPaise(taxablePaise)}</td>
                {isGst ? (
                  <>
                    <td className="py-1.5 text-right font-mono">{formatPaise(lineGst.cgstPaise)}</td>
                    <td className="py-1.5 text-right font-mono">{formatPaise(lineGst.sgstPaise)}</td>
                  </>
                ) : null}
                <td className="py-1.5 text-right font-mono font-medium text-gray-900">
                  {formatPaise(l.totalPaise)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {isGst && taxRateBreakdown.length > 0 ? (
        <div className="mb-4">
          <p className="text-xs font-semibold text-gray-700 mb-1">{t("print.tax_summary")}</p>
          <table className="w-full border border-gray-200 text-xs">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
              <tr>
                <th className="py-1 px-2 text-left">{t("print.rate")}</th>
                <th className="py-1 px-2 text-right">{t("print.taxable_value")}</th>
                <th className="py-1 px-2 text-right">{t("print.cgst")}</th>
                <th className="py-1 px-2 text-right">{t("print.sgst")}</th>
                <th className="py-1 px-2 text-right">{t("pos.tax")}</th>
              </tr>
            </thead>
            <tbody>
              {taxRateBreakdown.map((r) => (
                <tr key={r.taxRateBp} className="border-b border-gray-100 last:border-0 font-mono">
                  <td className="py-1 px-2 text-left">{(r.taxRateBp / 100).toFixed(1)}%</td>
                  <td className="py-1 px-2 text-right">₹{formatPaise(r.taxablePaise)}</td>
                  <td className="py-1 px-2 text-right">₹{formatPaise(r.cgstPaise)}</td>
                  <td className="py-1 px-2 text-right">₹{formatPaise(r.sgstPaise)}</td>
                  <td className="py-1 px-2 text-right font-semibold">₹{formatPaise(r.totalTaxPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex justify-between items-start my-4">
        <div className="max-w-md">
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">
            {t("print.amount_in_words")}
          </p>
          <p className="text-sm font-medium text-gray-900 italic">
            {amountInWords(bill.totalPaise)}
          </p>
        </div>
        <table className="w-64 text-xs font-mono">
          <tbody>
            <tr>
              <td className="text-gray-600 py-0.5">{t("pos.subtotal")}</td>
              <td className="text-right py-0.5">{formatPaise(bill.subtotalPaise)}</td>
            </tr>
            {bill.discountPaise > 0 ? (
              <tr>
                <td className="text-gray-600 py-0.5">{t("pos.bill_discount")}</td>
                <td className="text-right py-0.5 text-amber-700">-₹{formatPaise(bill.discountPaise)}</td>
              </tr>
            ) : null}
            {isGst && bill.taxPaise > 0 ? (
              <>
                <tr>
                  <td className="text-gray-600 py-0.5">{t("print.cgst")}</td>
                  <td className="text-right py-0.5">{formatPaise(tax.cgstPaise)}</td>
                </tr>
                <tr>
                  <td className="text-gray-600 py-0.5">{t("print.sgst")}</td>
                  <td className="text-right py-0.5">{formatPaise(tax.sgstPaise)}</td>
                </tr>
              </>
            ) : null}
            {bill.roundOffPaise !== 0 ? (
              <tr>
                <td className="text-gray-600 py-0.5">{t("pos.round_off")}</td>
                <td className="text-right py-0.5">
                  {bill.roundOffPaise > 0 ? "+" : ""}₹{formatPaise(bill.roundOffPaise)}
                </td>
              </tr>
            ) : null}
            <tr className="font-bold border-t border-gray-800 text-sm">
              <td className="pt-1.5">{t("pos.total")}</td>
              <td className="pt-1.5 text-right">₹{formatPaise(bill.totalPaise)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs">
        {t("bill.payments")}:{" "}
        {bill.payments
          .map((p) => `${paymentModeLabel(p.mode)} ₹${formatPaise(p.amountPaise)}`)
          .join(" · ")}
      </p>

      <div className="mt-8 pt-4 border-t border-gray-300 flex justify-between items-end text-xs">
        <div>
          <p className="font-semibold text-gray-800">{t("print.terms")}</p>
          <p className="text-gray-600">{t("print.terms_text")}</p>
        </div>
        <div className="text-center">
          <div className="w-48 border-b border-gray-400 mb-1" />
          <p className="text-gray-600">{t("print.authorised_signatory")}</p>
        </div>
      </div>
    </div>
  );
}

function ZReportDoc({
  data,
  profile,
}: {
  data: DayEndClosure;
  profile: ShopProfile | null;
}) {
  return (
    <div className="font-mono text-xs leading-tight max-w-[80mm] mx-auto" data-testid="z-report-doc">
      <p className="text-center font-bold text-sm">{profile?.name ?? "Store"}</p>
      {profile?.address ? <p className="text-center">{profile.address}</p> : null}
      {profile?.phone ? <p className="text-center">{profile.phone}</p> : null}
      {profile?.gstin ? <p className="text-center">GSTIN {profile.gstin}</p> : null}
      <hr className="border-dashed my-2" />
      <div className="text-center font-bold text-sm uppercase tracking-wider bg-gray-100 py-1">
        DAY-END CLOSING (Z-REPORT)
      </div>
      <div className="my-2 space-y-1">
        <div className="flex justify-between">
          <span>Date:</span>
          <span>{data.closureDate}</span>
        </div>
        <div className="flex justify-between">
          <span>Closed At:</span>
          <span>{new Date(data.createdAt).toLocaleTimeString()}</span>
        </div>
        {data.userName && (
          <div className="flex justify-between">
            <span>Cashier:</span>
            <span>{data.userName}</span>
          </div>
        )}
      </div>
      <hr className="border-dashed my-2" />
      <div className="space-y-1">
        <div className="flex justify-between">
          <span>Total Invoices:</span>
          <span className="font-bold">{data.totalBillsCount}</span>
        </div>
        <div className="flex justify-between">
          <span>Total Sales:</span>
          <span className="font-bold">₹{formatPaise(data.totalSalesPaise)}</span>
        </div>
      </div>
      <hr className="border-dashed my-2" />
      <div className="space-y-1">
        <p className="font-bold uppercase text-[10px] text-gray-500">CASH DRAWER RECONCILIATION</p>
        <div className="flex justify-between">
          <span>(+) Opening Cash:</span>
          <span>₹{formatPaise(data.openingCashPaise)}</span>
        </div>
        <div className="flex justify-between">
          <span>(+) Cash Sales:</span>
          <span>₹{formatPaise(data.cashSalesPaise)}</span>
        </div>
        <div className="flex justify-between">
          <span>(+) Credit Received:</span>
          <span>₹{formatPaise(data.creditReceivedPaise)}</span>
        </div>
        <div className="flex justify-between text-red-600">
          <span>(-) Cash Refunds:</span>
          <span>₹{formatPaise(data.cashRefundsPaise)}</span>
        </div>
        <div className="flex justify-between font-bold border-t border-dashed pt-1">
          <span>Expected Drawer Cash:</span>
          <span>₹{formatPaise(data.expectedCashPaise)}</span>
        </div>
        <div className="flex justify-between font-bold">
          <span>Actual Counted Cash:</span>
          <span>₹{formatPaise(data.actualCashPaise)}</span>
        </div>
        <div
          className={`flex justify-between font-bold text-sm border-t border-b border-dashed py-1 ${
            data.variancePaise === 0 ? "text-green-700" : "text-red-700"
          }`}
        >
          <span>Variance:</span>
          <span>{data.variancePaise >= 0 ? "+" : ""}₹{formatPaise(data.variancePaise)}</span>
        </div>
      </div>
      {data.notes && (
        <div className="mt-2 text-gray-600 text-[11px]">
          Notes: {data.notes}
        </div>
      )}
      <hr className="border-dashed my-2" />
      <p className="text-center text-[10px] text-gray-500">END OF Z-REPORT</p>
    </div>
  );
}

export function PrintView() {
  const printJob = useAppStore((s) => s.printJob);
  const clearPrintJob = useAppStore((s) => s.clearPrintJob);
  const profile = useAppStore((s) => s.profile);
  const shopLogo = useAppStore((s) => s.shopLogo);
  const [bill, setBill] = useState<BillDetail | null>(null);
  const [creditNote, setCreditNote] = useState<CreditNote | null>(null);
  const [zReportData, setZReportData] = useState<DayEndClosure | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [showing, setShowing] = useState(false);

  // Load the bill or credit note or z-report and mark the body as printing.
  useEffect(() => {
    if (!printJob) {
      setBill(null);
      setCreditNote(null);
      setZReportData(null);
      setCustomer(null);
      setShowing(false);
      document.body.classList.remove("printing");
      return;
    }
    let cancelled = false;
    void (async () => {
      const repo = getRepository();

      if (printJob.variant === "z-report" && printJob.dayEndData) {
        setZReportData(printJob.dayEndData);
        setShowing(true);
        document.body.classList.add("printing");
        return;
      }

      if (printJob.creditNoteId) {
        const cn = await repo.getCreditNote(printJob.creditNoteId);
        if (cancelled || !cn) return;
        setCreditNote(cn);
        setShowing(true);
        document.body.classList.add("printing");
        return;
      }

      if (printJob.billId) {
        const detail = await repo.getBill(printJob.billId);
        if (cancelled || !detail) return;
        setBill(detail);

        if (detail.customerId) {
          const custs = await repo.listCustomers();
          const found = custs.find((c) => c.id === detail.customerId);
          if (!cancelled) setCustomer(found ?? null);
        } else {
          setCustomer(null);
        }

        setShowing(true);
        document.body.classList.add("printing");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [printJob]);

  /**
   * Hides the document after `afterprint`. It clears the job too, but only
   * after paint: `afterprint` can arrive before React commits the render that
   * shows the document, and dropping the job first would skip printing.
   */
  const close = useCallback(() => {
    setShowing(false);
    document.body.classList.remove("printing");
    setTimeout(() => clearPrintJob(), 0);
  }, [clearPrintJob]);

  useEffect(() => {
    if (!showing) return;
    const timer = setTimeout(() => {
      if (import.meta.env.DEV) console.info("[dev] window.print() called");
      window.print();
    }, 100);
    window.addEventListener("afterprint", close);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("afterprint", close);
    };
  }, [showing, close]);

  if (!showing || !printJob) return null;
  if (!bill && !creditNote && !zReportData) return null;

  return (
    <div
      className={`print-area ${printJob.variant === "invoice-a4" ? "a4-invoice" : printJob.variant} bg-white p-4 mx-auto`}
      data-testid="print-view"
    >
      <button
        type="button"
        data-testid="print-close"
        className="print:hidden mb-3 rounded border px-3 py-1 text-sm"
        onClick={close}
      >
        {t("print.close")}
      </button>
      {zReportData ? (
        <ZReportDoc data={zReportData} profile={profile} />
      ) : creditNote ? (
        <CreditNoteDoc creditNote={creditNote} profile={profile} />
      ) : printJob.variant === "invoice-a4" ? (
        bill ? <InvoiceDoc bill={bill} customer={customer} profile={profile} logo={shopLogo} /> : null
      ) : (
        bill ? <ReceiptDoc bill={bill} customer={customer} profile={profile} logo={shopLogo} /> : null
      )}
    </div>
  );
}
