// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatPaise, parsePaise } from "@mytowncart-billing/core";
import type { Item, Supplier } from "@mytowncart-billing/storage";
import { Button, Input, Money, PageHeader } from "../components/ui";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

interface FormLine {
  itemId: number;
  name: string;
  qtyUnits: string;
  unitCostRupees: string;
  taxRatePct: string;
  batchNo?: string;
  mfgDate?: string;
  expiryDate?: string;
}

export function PurchaseFormScreen() {
  const navigate = useNavigate();
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<FormLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Line creation state
  const [selectedItemId, setSelectedItemId] = useState<number | "">("");
  const [lineQty, setLineQty] = useState("1");
  const [lineCost, setLineCost] = useState("");
  const [lineTaxPct, setLineTaxPct] = useState("0");
  const [lineBatchNo, setLineBatchNo] = useState("");
  const [lineMfgDate, setLineMfgDate] = useState("");
  const [lineExpiryDate, setLineExpiryDate] = useState("");

  useEffect(() => {
    void getRepository().listSuppliers().then(setSuppliers);
    void getRepository().listItems({ activeOnly: true }).then(setItems);
  }, []);

  const handleItemSelect = (id: number) => {
    setSelectedItemId(id);
    const item = items.find((i) => i.id === id);
    if (item) {
      setLineCost(formatPaise(item.costPricePaise || item.pricePaise));
      setLineTaxPct(String(item.taxRateBp / 100));
    }
  };

  const addLine = () => {
    if (!selectedItemId) return;
    const item = items.find((i) => i.id === selectedItemId);
    if (!item) return;
    const qty = parseFloat(lineQty);
    if (isNaN(qty) || qty <= 0) return;

    setLines((prev) => [
      ...prev,
      {
        itemId: item.id,
        name: item.name,
        qtyUnits: lineQty,
        unitCostRupees: lineCost || "0",
        taxRatePct: lineTaxPct || "0",
        batchNo: lineBatchNo.trim() || undefined,
        mfgDate: lineMfgDate.trim() || undefined,
        expiryDate: lineExpiryDate.trim() || undefined,
      },
    ]);

    // Reset line fields
    setSelectedItemId("");
    setLineQty("1");
    setLineCost("");
    setLineTaxPct("0");
    setLineBatchNo("");
    setLineMfgDate("");
    setLineExpiryDate("");
  };

  const removeLine = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  // Computations
  let computedSubtotal = 0;
  let computedTax = 0;
  let computedTotal = 0;

  for (const l of lines) {
    const qtyMilli = Math.round(parseFloat(l.qtyUnits || "0") * 1000);
    const unitCostPaise = parsePaise(l.unitCostRupees || "0") ?? 0;
    const taxRateBp = Math.round(parseFloat(l.taxRatePct || "0") * 100);

    const lineSubtotal = Math.floor((qtyMilli * unitCostPaise) / 1000);
    const lineTax = Math.floor((lineSubtotal * taxRateBp + 5000) / 10000);
    const lineTotal = lineSubtotal + lineTax;

    computedSubtotal += lineSubtotal;
    computedTax += lineTax;
    computedTotal += lineTotal;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supplierId) {
      setError("Please select a supplier");
      return;
    }
    if (!invoiceNo.trim()) {
      setError("Please enter the vendor invoice number");
      return;
    }
    if (lines.length === 0) {
      setError("Please add at least one line item");
      return;
    }

    try {
      setSubmitting(true);
      setError(null);

      await getRepository().createPurchase({
        supplierId: Number(supplierId),
        invoiceNo: invoiceNo.trim(),
        invoiceDate,
        createdAt: new Date().toISOString(),
        lines: lines.map((l) => ({
          itemId: l.itemId,
          nameSnapshot: l.name,
          qtyMilli: Math.round(parseFloat(l.qtyUnits) * 1000),
          unitCostPaise: parsePaise(l.unitCostRupees) ?? 0,
          taxRateBp: Math.round(parseFloat(l.taxRatePct) * 100),
        })),
      });

      // Upsert any batches specified for lines
      for (const l of lines) {
        if (l.batchNo && l.expiryDate) {
          const item = items.find((i) => i.id === l.itemId);
          await getRepository().upsertBatch({
            itemId: l.itemId,
            batchNo: l.batchNo,
            mfgDate: l.mfgDate || null,
            expiryDate: l.expiryDate,
            costPricePaise: parsePaise(l.unitCostRupees) ?? 0,
            mrpPaise: item?.mrpPaise ?? parsePaise(l.unitCostRupees) ?? 0,
            stockMilli: Math.round(parseFloat(l.qtyUnits) * 1000),
          });
        }
      }

      bumpDataVersion();
      navigate("/purchases");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-24">
      <PageHeader
        title={t("purchases.record")}
        actions={
          <Link
            to="/purchases"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors shadow-2xs"
          >
            ← {t("common.back")}
          </Link>
        }
      />

      <form onSubmit={(e) => void onSubmit(e)} className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 rounded-lg border border-gray-200 bg-white p-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("purchases.supplier")} *
            </label>
            <select
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
              data-testid="purchase-supplier"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">{t("purchases.select_supplier")}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <Input
            label={`${t("purchases.invoice_no")} *`}
            data-testid="purchase-invoice-no"
            value={invoiceNo}
            onChange={(e) => setInvoiceNo(e.target.value)}
            placeholder="e.g. INV-98765"
          />

          <Input
            label={`${t("purchases.invoice_date")} *`}
            type="date"
            data-testid="purchase-invoice-date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
          />
        </div>

        {/* Add Line Item Box */}
        <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-4">
          <h2 className="text-sm font-semibold text-gray-800 mb-3">{t("purchases.add_item")}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {t("print.item")}
              </label>
              <select
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
                data-testid="purchase-item-select"
                value={selectedItemId}
                onChange={(e) =>
                  e.target.value ? handleItemSelect(Number(e.target.value)) : setSelectedItemId("")
                }
              >
                <option value="">Choose item…</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} (Stock: {i.stockMilli / 1000})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {t("common.qty")}
              </label>
              <input
                type="number"
                step="0.001"
                min="0.001"
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
                data-testid="purchase-qty"
                value={lineQty}
                onChange={(e) => setLineQty(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Cost Price (₹)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
                data-testid="purchase-cost"
                value={lineCost}
                onChange={(e) => setLineCost(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Batch No (Opt)
              </label>
              <input
                type="text"
                placeholder="e.g. B-101"
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
                data-testid="purchase-batch-no"
                value={lineBatchNo}
                onChange={(e) => setLineBatchNo(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Expiry Date (Opt)
              </label>
              <input
                type="date"
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
                data-testid="purchase-expiry-date"
                value={lineExpiryDate}
                onChange={(e) => setLineExpiryDate(e.target.value)}
              />
            </div>

            <div>
              <Button
                type="button"
                variant="primary"
                data-testid="purchase-add-line"
                disabled={!selectedItemId || parseFloat(lineQty) <= 0}
                onClick={addLine}
              >
                + Add
              </Button>
            </div>
          </div>
        </div>

        {/* Lines Table */}
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-gray-600 font-medium">
              <tr>
                <th className="px-3 py-2">{t("print.item")}</th>
                <th className="px-3 py-2 text-right">{t("common.qty")}</th>
                <th className="px-3 py-2 text-right">Cost Price (₹)</th>
                <th className="px-3 py-2 text-right">Tax Rate</th>
                <th className="px-3 py-2 text-right">{t("common.total")}</th>
                <th className="px-3 py-2 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {lines.map((l, idx) => {
                const qtyMilli = Math.round(parseFloat(l.qtyUnits || "0") * 1000);
                const unitCostPaise = parsePaise(l.unitCostRupees || "0") ?? 0;
                const taxRateBp = Math.round(parseFloat(l.taxRatePct || "0") * 100);
                const lineSub = Math.floor((qtyMilli * unitCostPaise) / 1000);
                const lineTax = Math.floor((lineSub * taxRateBp + 5000) / 10000);
                const lineTot = lineSub + lineTax;

                return (
                  <tr key={idx} data-testid={`purchase-line-${idx}`}>
                    <td className="px-3 py-2 font-medium text-gray-800">
                      <div>{l.name}</div>
                      {l.batchNo && (
                        <div className="text-xs text-gray-500 font-mono">
                          Batch: {l.batchNo} {l.expiryDate ? `· Exp: ${l.expiryDate}` : ""}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{l.qtyUnits}</td>
                    <td className="px-3 py-2 text-right font-mono">₹{l.unitCostRupees}</td>
                    <td className="px-3 py-2 text-right font-mono">{l.taxRatePct}%</td>
                    <td className="px-3 py-2 text-right font-medium">
                      <Money paise={lineTot} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        type="button"
                        className="text-xs text-red-600 hover:underline"
                        onClick={() => removeLine(idx)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-gray-600">
                    No items added yet. Add items using the box above.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* Totals & Submit */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-4 rounded-lg border border-gray-200">
          <div className="space-y-1 text-sm text-gray-600">
            <div>
              Subtotal: <Money paise={computedSubtotal} />
            </div>
            <div>
              Tax: <Money paise={computedTax} />
            </div>
            <div className="text-base font-bold text-gray-900">
              Total Invoice Amount: <Money paise={computedTotal} />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Link to="/purchases">
              <Button variant="secondary" type="button">
                {t("common.cancel")}
              </Button>
            </Link>
            <Button
              variant="primary"
              type="submit"
              data-testid="purchase-submit"
              disabled={submitting || lines.length === 0 || !supplierId || !invoiceNo.trim()}
            >
              {submitting ? t("common.saving") : "Save & Update Stock"}
            </Button>
          </div>
        </div>

        {error ? <p className="text-sm text-red-600 bg-red-50 p-3 rounded border border-red-200">{error}</p> : null}
      </form>
    </div>
  );
}
