// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { formatPaise } from "@mytowncart-billing/core";
import type { BillSummary } from "@mytowncart-billing/storage";
import { t, type I18nKey } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

export function BillsScreen() {
  const dataVersion = useAppStore((s) => s.dataVersion);
  const [bills, setBills] = useState<BillSummary[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await getRepository().listBills({ search: search || undefined });
      if (!cancelled) setBills(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [search, dataVersion]);

  return (
    <div>
      <h1 className="mb-4 text-lg font-bold">{t("bills.title")}</h1>

      <input
        className="mb-3 w-full max-w-sm rounded border border-gray-300 px-3 py-2 text-sm"
        placeholder={t("bills.search_ph")}
        data-testid="bills-search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {bills.length === 0 ? (
        <p className="text-sm text-gray-500">{t("bills.empty")}</p>
      ) : (
        <table className="w-full rounded border border-gray-200 bg-white text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="px-3 py-2">{t("bills.number")}</th>
              <th className="px-3 py-2">{t("bills.date")}</th>
              <th className="px-3 py-2">{t("bills.customer")}</th>
              <th className="px-3 py-2">{t("bills.status")}</th>
              <th className="px-3 py-2 text-right">{t("common.total")}</th>
              <th className="px-3 py-2">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.id} className="border-b border-gray-100 last:border-0">
                <td className="px-3 py-2 font-mono">{b.number}</td>
                <td className="px-3 py-2">{new Date(b.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">{b.customerName ?? "—"}</td>
                <td className="px-3 py-2">
                  <span
                    className={
                      b.status === "void"
                        ? "rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700"
                        : "rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700"
                    }
                  >
                    {t(`bills.status.${b.status}` as I18nKey)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">₹{formatPaise(b.totalPaise)}</td>
                <td className="px-3 py-2">
                  <Link
                    to={`/bills/${b.id}`}
                    className="text-sm text-blue-600 hover:underline"
                    data-testid={`bill-open-${b.number}`}
                  >
                    {t("bills.view")}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
