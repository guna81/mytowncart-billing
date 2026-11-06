// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Purchase, Supplier } from "@mytowncart-billing/storage";
import { Button, Money, EmptyState, PageHeader } from "../components/ui";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { formatDate } from "../lib/formatDate";

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
      <PageHeader
        title={t("purchases.title")}
        actions={
          <Link to="/purchases/new">
            <Button variant="primary" data-testid="purchases-new">
              + {t("purchases.record")}
            </Button>
          </Link>
        }
      />

      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700">{t("purchases.supplier")}:</label>
        <select
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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

      {purchases.length === 0 ? (
        <EmptyState
          title={t("purchases.empty")}
          hint={t("purchases.empty_hint")}
          action={
            <Link to="/purchases/new">
              <Button variant="primary">
                + {t("purchases.record")}
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-gray-700 font-semibold">
              <tr>
                <th className="px-3 py-2.5">{t("purchases.invoice_date")}</th>
                <th className="px-3 py-2.5">{t("purchases.invoice_no")}</th>
                <th className="px-3 py-2.5">{t("purchases.supplier")}</th>
                <th className="px-3 py-2.5 text-right">{t("purchases.items")}</th>
                <th className="px-3 py-2.5 text-right">{t("pos.subtotal")}</th>
                <th className="px-3 py-2.5 text-right">{t("pos.tax")}</th>
                <th className="px-3 py-2.5 text-right">{t("common.total")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {purchases.map((p) => (
                <tr key={p.id} data-testid={`purchase-row-${p.id}`} className="hover:bg-gray-50">
                  <td className="px-3 py-2.5 text-gray-700">{formatDate(p.invoiceDate)}</td>
                  <td className="px-3 py-2.5 font-mono font-medium text-gray-900">{p.invoiceNo}</td>
                  <td className="px-3 py-2.5 font-medium text-gray-800">{p.supplierName || "—"}</td>
                  <td className="px-3 py-2.5 text-right text-gray-600 font-mono">
                    {p.lines.length}
                  </td>
                  <td className="px-3 py-2.5 text-right text-gray-700">
                    <Money paise={p.subtotalPaise} />
                  </td>
                  <td className="px-3 py-2.5 text-right text-gray-700">
                    <Money paise={p.taxPaise} />
                  </td>
                  <td className="px-3 py-2.5 text-right font-bold text-gray-900">
                    <Money paise={p.totalPaise} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
