// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Purchase, Supplier } from "@mytowncart-billing/storage";
import { Button, Money } from "../components/ui";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";

export function PurchasesScreen() {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplier, setSelectedSupplier] = useState<number | undefined>(undefined);

  useEffect(() => {
    void getRepository().listSuppliers().then(setSuppliers);
  }, []);

  useEffect(() => {
    void getRepository().listPurchases(selectedSupplier).then(setPurchases);
  }, [selectedSupplier]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold">{t("purchases.title")}</h1>
        <Link to="/purchases/new">
          <Button variant="primary" data-testid="purchases-new">
            + {t("purchases.record")}
          </Button>
        </Link>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700">{t("purchases.supplier")}:</label>
        <select
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
          data-testid="purchases-filter-supplier"
          value={selectedSupplier ?? ""}
          onChange={(e) => setSelectedSupplier(e.target.value ? Number(e.target.value) : undefined)}
        >
          <option value="">All Suppliers</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-gray-600 font-medium">
            <tr>
              <th className="px-3 py-2">{t("purchases.invoice_date")}</th>
              <th className="px-3 py-2">{t("purchases.invoice_no")}</th>
              <th className="px-3 py-2">{t("purchases.supplier")}</th>
              <th className="px-3 py-2 text-right">{t("purchases.items")}</th>
              <th className="px-3 py-2 text-right">{t("pos.subtotal")}</th>
              <th className="px-3 py-2 text-right">{t("pos.tax")}</th>
              <th className="px-3 py-2 text-right">{t("common.total")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {purchases.map((p) => (
              <tr key={p.id} data-testid={`purchase-row-${p.id}`}>
                <td className="px-3 py-2 text-gray-600">{p.invoiceDate}</td>
                <td className="px-3 py-2 font-mono font-medium text-gray-900">{p.invoiceNo}</td>
                <td className="px-3 py-2 font-medium text-gray-800">{p.supplierName || "—"}</td>
                <td className="px-3 py-2 text-right text-gray-600 font-mono">
                  {p.lines.length}
                </td>
                <td className="px-3 py-2 text-right text-gray-600">
                  <Money paise={p.subtotalPaise} />
                </td>
                <td className="px-3 py-2 text-right text-gray-600">
                  <Money paise={p.taxPaise} />
                </td>
                <td className="px-3 py-2 text-right font-bold text-gray-900">
                  <Money paise={p.totalPaise} />
                </td>
              </tr>
            ))}
            {purchases.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-4 text-center text-gray-500">
                  {t("purchases.empty")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
