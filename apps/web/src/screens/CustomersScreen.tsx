// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type FormEvent } from "react";

import type { Customer } from "@mytowncart-billing/storage";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";

const inputCls = "mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm";
const labelCls = "block text-sm font-medium text-gray-700";

function CustomerDialog({ onClose, onSaved }: { onClose(): void; onSaved(): void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("common.name"));
      return;
    }
    await getRepository().upsertCustomer({ name: name.trim(), phone: phone.trim() });
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30 p-4">
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="w-full max-w-sm rounded bg-white p-4 shadow-lg"
        data-testid="customer-dialog"
      >
        <h2 className="mb-3 font-semibold">{t("customers.add")}</h2>
        <label className={labelCls}>
          {t("common.name")}
          <input
            autoFocus
            className={inputCls}
            data-testid="customer-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className={`${labelCls} mt-3`}>
          {t("common.phone")}
          <input
            className={inputCls}
            data-testid="customer-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            data-testid="customer-save"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
          >
            {t("common.save")}
          </button>
        </div>
      </form>
    </div>
  );
}

export function CustomersScreen() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await getRepository().listCustomers(search || undefined);
      if (!cancelled) setCustomers(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [search, version]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold">{t("customers.title")}</h1>
        <button
          type="button"
          data-testid="customers-add"
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
          onClick={() => setAdding(true)}
        >
          {t("customers.add")}
        </button>
      </div>

      <input
        className="mb-3 w-full max-w-sm rounded border border-gray-300 px-3 py-2 text-sm"
        placeholder={t("customers.search_ph")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {customers.length === 0 ? (
        <p className="text-sm text-gray-500">{t("customers.empty")}</p>
      ) : (
        <table className="w-full rounded border border-gray-200 bg-white text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="px-3 py-2">{t("common.name")}</th>
              <th className="px-3 py-2">{t("common.phone")}</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id} className="border-b border-gray-100 last:border-0">
                <td className="px-3 py-2 font-medium">{c.name}</td>
                <td className="px-3 py-2">{c.phone || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding ? (
        <CustomerDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            setVersion((v) => v + 1);
          }}
        />
      ) : null}
    </div>
  );
}
