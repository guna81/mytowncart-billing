// SPDX-License-Identifier: Apache-2.0
/**
 * Receipt/invoice printing (roadmap §8.9): browser print of a 58/80 mm
 * receipt template or an A4 invoice. The document is rendered into
 * `.print-area`; while a print job is active the app shell hides (see
 * styles.css) and `window.print()` opens the system dialog.
 */
import { useCallback, useEffect, useState } from "react";

import { formatPaise, formatQty, splitGst } from "@mytowncart-billing/core";
import type { BillDetail, ShopProfile } from "@mytowncart-billing/storage";
import { t } from "../i18n";
import { paymentModeLabel } from "../lib/labels";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

function ReceiptDoc({ bill, profile }: { bill: BillDetail; profile: ShopProfile | null }) {
  const tax = splitGst(bill.taxPaise);
  return (
    <div className="font-mono text-xs leading-tight">
      <p className="text-center font-bold text-sm">{profile?.name ?? ""}</p>
      {profile?.address ? <p className="text-center">{profile.address}</p> : null}
      {profile?.phone ? <p className="text-center">{profile.phone}</p> : null}
      {profile?.gstin ? <p className="text-center">GSTIN {profile.gstin}</p> : null}
      <hr className="border-dashed my-1" />
      <p>
        {bill.number} · {new Date(bill.createdAt).toLocaleString()}
        {bill.status === "void" ? ` · ${t("print.void_copy")}` : ""}
      </p>
      <hr className="border-dashed my-1" />
      <table className="w-full">
        <tbody>
          {bill.lines.map((l) => (
            <tr key={l.id}>
              <td className="align-top pr-1">
                {l.nameSnapshot}
                <br />
                <span className="text-gray-500">
                  {formatQty(l.qtyMilli)} × {formatPaise(l.unitPricePaise)}
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
      {profile?.receiptFooter ? <p className="text-center mt-2">{profile.receiptFooter}</p> : null}
      <p className="text-center mt-1">{t("print.thank_you")}</p>
    </div>
  );
}

function InvoiceDoc({ bill, profile }: { bill: BillDetail; profile: ShopProfile | null }) {
  const tax = splitGst(bill.taxPaise);
  return (
    <div className="text-sm">
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-xl font-bold">{profile?.name ?? ""}</h1>
          {profile?.address ? <p>{profile.address}</p> : null}
          {profile?.phone ? <p>{profile.phone}</p> : null}
          {profile?.gstin ? <p>GSTIN: {profile.gstin}</p> : null}
        </div>
        <div className="text-right">
          <h2 className="text-lg font-semibold">{t("print.invoice")}</h2>
          <p className="font-mono">{bill.number}</p>
          <p>{new Date(bill.createdAt).toLocaleString()}</p>
          <p>{t("bill.fy", { fy: bill.fy })}</p>
          {bill.status === "void" ? (
            <p className="font-bold text-red-600">{t("print.void_copy")}</p>
          ) : null}
        </div>
      </div>
      {bill.customerName ? (
        <p className="mb-4">
          {t("bills.customer")}: {bill.customerName}
        </p>
      ) : null}
      <table className="w-full border-collapse mb-4">
        <thead>
          <tr className="border-b-2 border-gray-800 text-left">
            <th className="py-1">{t("print.item")}</th>
            <th className="py-1 text-right">{t("common.qty")}</th>
            <th className="py-1 text-right">{t("common.price")}</th>
            <th className="py-1 text-right">{t("pos.tax")}</th>
            <th className="py-1 text-right">{t("common.total")}</th>
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((l) => (
            <tr key={l.id} className="border-b border-gray-300">
              <td className="py-1">{l.nameSnapshot}</td>
              <td className="py-1 text-right">{formatQty(l.qtyMilli)}</td>
              <td className="py-1 text-right">{formatPaise(l.unitPricePaise)}</td>
              <td className="py-1 text-right">{formatPaise(l.taxPaise)}</td>
              <td className="py-1 text-right">{formatPaise(l.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex justify-end">
        <table className="w-64">
          <tbody>
            <tr>
              <td>{t("pos.subtotal")}</td>
              <td className="text-right">{formatPaise(bill.subtotalPaise)}</td>
            </tr>
            <tr>
              <td>{t("print.cgst")}</td>
              <td className="text-right">{formatPaise(tax.cgstPaise)}</td>
            </tr>
            <tr>
              <td>{t("print.sgst")}</td>
              <td className="text-right">{formatPaise(tax.sgstPaise)}</td>
            </tr>
            <tr className="font-bold border-t border-gray-800">
              <td className="pt-1">{t("pos.total")}</td>
              <td className="pt-1 text-right">₹{formatPaise(bill.totalPaise)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-4">
        {t("bill.payments")}:{" "}
        {bill.payments.map((p) => `${paymentModeLabel(p.mode)} ${formatPaise(p.amountPaise)}`).join(" · ")}
      </p>
    </div>
  );
}

export function PrintView() {
  const printJob = useAppStore((s) => s.printJob);
  const clearPrintJob = useAppStore((s) => s.clearPrintJob);
  const profile = useAppStore((s) => s.profile);
  const [bill, setBill] = useState<BillDetail | null>(null);
  const [showing, setShowing] = useState(false);

  // Load the bill and mark the body as printing.
  useEffect(() => {
    if (!printJob) {
      setBill(null);
      setShowing(false);
      document.body.classList.remove("printing");
      return;
    }
    let cancelled = false;
    void getRepository()
      .getBill(printJob.billId)
      .then((detail) => {
        if (cancelled || !detail) return;
        setBill(detail);
        setShowing(true);
        document.body.classList.add("printing");
      });
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

  if (!showing || !printJob || !bill) return null;

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
      {printJob.variant === "invoice-a4" ? (
        <InvoiceDoc bill={bill} profile={profile} />
      ) : (
        <ReceiptDoc bill={bill} profile={profile} />
      )}
    </div>
  );
}
