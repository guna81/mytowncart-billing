// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { formatPaise } from "@mytowncart-billing/core";
import type { BillSummary } from "@mytowncart-billing/storage";
import { t, type I18nKey } from "../i18n";
import { getRepository } from "../lib/repository";
import { formatDate } from "../lib/formatDate";
import { useAppStore } from "../store/appStore";
import { EmptyState, PageHeader } from "../components/ui";

export function BillsScreen() {
  const navigate = useNavigate();
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
      <PageHeader title={t("bills.title")} />

      <input
        className="mb-4 w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        placeholder={t("bills.search_ph")}
        data-testid="bills-search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {bills.length === 0 ? (
        <EmptyState
          title={t("bills.empty")}
          hint={t("bills.empty_hint")}
          action={
            <Link
              to="/"
              className="rounded-md bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
            >
              {t("pos.title")}
            </Link>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left font-semibold text-gray-700">
                <th className="px-3 py-2.5">{t("bills.number")}</th>
                <th className="px-3 py-2.5">{t("bills.date")}</th>
                <th className="px-3 py-2.5">{t("bills.customer")}</th>
                <th className="px-3 py-2.5">{t("bills.status")}</th>
                <th className="px-3 py-2.5 text-right">{t("common.total")}</th>
                <th className="px-3 py-2.5">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr
                  key={b.id}
                  onClick={() => navigate(`/bills/${b.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/bills/${b.id}`);
                    }
                  }}
                  tabIndex={0}
                  role="link"
                  className="cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none transition-colors"
                >
                  <td className="px-3 py-2.5 font-mono font-medium text-gray-900">{b.number}</td>
                  <td className="px-3 py-2.5 text-gray-700">{formatDate(b.createdAt)}</td>
                  <td className="px-3 py-2.5 text-gray-700">{b.customerName ?? "—"}</td>
                  <td className="px-3 py-2.5">
                    <span
                      className={
                        b.status === "void"
                          ? "rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700"
                          : "rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700"
                      }
                    >
                      {t(`bills.status.${b.status}` as I18nKey)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold text-gray-900">
                    ₹{formatPaise(b.totalPaise)}
                  </td>
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <Link
                      to={`/bills/${b.id}`}
                      className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
                      data-testid={`bill-open-${b.number}`}
                    >
                      {t("bills.view")}
                    </Link>
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
