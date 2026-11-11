// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type FormEvent } from "react";
import { formatPaise, parsePaise } from "@mytowncart-billing/core";
import type { Customer, CustomerLedgerSummary } from "@mytowncart-billing/storage";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { formatDate } from "../lib/formatDate";
import { EmptyState, PageHeader } from "../components/ui";
import { CustomerDialog } from "../components/CustomerDialog";

const inputCls = "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 shadow-2xs";
const labelCls = "block text-sm font-medium text-gray-700";

function ReceivePaymentDialog({
  customer,
  onClose,
  onSuccess,
}: {
  customer: Customer;
  onClose(): void;
  onSuccess(): void;
}) {
  const [amount, setAmount] = useState("");
  const [paymentMode, setPaymentMode] = useState<"cash" | "upi" | "card" | "bank">("cash");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parsePaise(amount);
    if (parsed === null || parsed <= 0) {
      setError(t("pos.error.insufficient"));
      return;
    }
    await getRepository().recordCustomerPayment({
      customerId: customer.id,
      amountPaise: parsed,
      mode: paymentMode,
      notes: notes.trim() || undefined,
    });
    onSuccess();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
        data-testid="receive-payment-dialog"
      >
        <h3 className="mb-3 text-base font-semibold">
          {t("customers.receive_payment_title", { name: customer.name })}
        </h3>

        <label className={labelCls}>
          {t("customers.payment_amount")} *
          <input
            autoFocus
            type="number"
            step="0.01"
            min="0.01"
            className={inputCls}
            data-testid="customer-payment-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>

        <label className={`${labelCls} mt-3`}>
          {t("customers.payment_mode")}
          <select
            className={inputCls}
            value={paymentMode}
            onChange={(e) =>
              setPaymentMode(e.target.value as "cash" | "upi" | "card" | "bank")
            }
          >
            <option value="cash">{t("pos.mode.cash")}</option>
            <option value="upi">{t("pos.mode.upi")}</option>
            <option value="card">{t("pos.mode.card")}</option>
            <option value="bank">Bank / Transfer</option>
          </select>
        </label>

        <label className={`${labelCls} mt-3`}>
          {t("customers.payment_notes")}
          <input
            className={inputCls}
            placeholder="e.g. UPI ref # / Cheque #"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
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
            data-testid="customer-payment-save"
            className="rounded bg-green-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-700"
          >
            {t("common.save")}
          </button>
        </div>
      </form>
    </div>
  );
}

function CustomerLedgerDialog({
  customer,
  onClose,
}: {
  customer: Customer;
  onClose(): void;
}) {
  const [ledger, setLedger] = useState<CustomerLedgerSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const data = await getRepository().getCustomerLedger(customer.id);
      if (!cancelled) {
        setLedger(data);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customer.id, version]);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30 p-4">
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-white p-5 shadow-xl"
        data-testid="customer-ledger-dialog"
      >
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <h2 className="text-base font-bold text-gray-900">
              {t("customers.ledger_title", { name: customer.name })}
            </h2>
            {customer.phone ? (
              <p className="text-xs text-gray-500">{customer.phone}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          >
            ✕
          </button>
        </div>

        {notice ? (
          <div className="mt-2 rounded bg-green-50 p-2 text-xs text-green-700">
            {notice}
          </div>
        ) : null}

        {loading ? (
          <p className="py-6 text-center text-sm text-gray-500">{t("common.loading")}</p>
        ) : ledger ? (
          <>
            <div className="my-4 flex items-center justify-between rounded-lg bg-gray-50 p-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
                  {t("customers.outstanding_balance")}
                </p>
                <p
                  data-testid="customer-outstanding-balance"
                  className={`mt-1 text-2xl font-bold ${
                    ledger.outstandingBalancePaise > 0 ? "text-red-600" : "text-green-700"
                  }`}
                >
                  ₹{formatPaise(ledger.outstandingBalancePaise)}
                </p>
              </div>
              <div className="text-center px-4">
                <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
                  Loyalty Points
                </p>
                <p className="mt-1 text-2xl font-bold text-purple-700 font-mono">
                  {customer.loyaltyPoints ?? 0} pts
                </p>
              </div>
              <button
                type="button"
                data-testid="customer-receive-payment"
                onClick={() => setReceiveOpen(true)}
                className="rounded bg-green-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-700"
              >
                {t("customers.receive_payment")}
              </button>
            </div>

            <div className="mb-2">
              <h3 className="text-sm font-semibold text-gray-700">
                {t("customers.statement")}
              </h3>
            </div>

            <div className="flex-1 overflow-auto rounded border border-gray-200">
              {ledger.entries.length === 0 ? (
                <p className="p-4 text-center text-sm text-gray-500">
                  {t("customers.statement_empty")}
                </p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-gray-100 font-semibold text-gray-600">
                    <tr>
                      <th className="px-3 py-2">{t("bills.date")}</th>
                      <th className="px-3 py-2">Details</th>
                      <th className="px-3 py-2 text-right">{t("customers.debit")}</th>
                      <th className="px-3 py-2 text-right">{t("customers.credit")}</th>
                      <th className="px-3 py-2 text-right">{t("customers.balance")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {ledger.entries.map((e, idx) => (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                          {formatDate(e.date)}
                        </td>
                        <td className="px-3 py-2 text-gray-800">
                          {e.description}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-red-600">
                          {e.debitPaise > 0 ? `₹${formatPaise(e.debitPaise)}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-green-700">
                          {e.creditPaise > 0 ? `₹${formatPaise(e.creditPaise)}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-medium">
                          ₹{formatPaise(e.balancePaise)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : null}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            {t("common.close")}
          </button>
        </div>
      </div>

      {receiveOpen ? (
        <ReceivePaymentDialog
          customer={customer}
          onClose={() => setReceiveOpen(false)}
          onSuccess={() => {
            setReceiveOpen(false);
            setNotice(t("customers.payment_recorded"));
            setVersion((v) => v + 1);
          }}
        />
      ) : null}
    </div>
  );
}

export function CustomersScreen() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [editingCustomer, setEditingCustomer] = useState<Customer | null | "new">(null);
  const [ledgerCustomer, setLedgerCustomer] = useState<Customer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
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

  const onDelete = async (c: Customer) => {
    if (!window.confirm(t("customers.delete_confirm", { name: c.name }))) return;
    try {
      setErrorNotice(null);
      await getRepository().deleteCustomer(c.id);
      setNotice(`Customer "${c.name}" deleted.`);
      setVersion((v) => v + 1);
    } catch {
      setErrorNotice(t("customers.delete_has_history"));
    }
  };

  return (
    <div>
      <PageHeader
        title={t("customers.title")}
        actions={
          <button
            type="button"
            data-testid="customers-add"
            className="rounded-md bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
            onClick={() => setEditingCustomer("new")}
          >
            {t("customers.add")}
          </button>
        }
      />

      {notice ? (
        <div className="mb-3 rounded bg-green-50 p-2.5 text-sm text-green-700">{notice}</div>
      ) : null}
      {errorNotice ? (
        <div className="mb-3 rounded bg-red-50 p-2.5 text-sm text-red-700">{errorNotice}</div>
      ) : null}

      <input
        className="mb-4 w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        placeholder={t("customers.search_ph")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {customers.length === 0 ? (
        <EmptyState
          title={t("customers.empty")}
          hint={t("customers.empty_hint")}
          action={
            <button
              type="button"
              className="rounded-md bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
              onClick={() => setEditingCustomer("new")}
            >
              {t("customers.add")}
            </button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left font-semibold text-gray-700">
                <th className="px-3 py-2.5">{t("common.name")}</th>
                <th className="px-3 py-2.5">{t("common.phone")}</th>
                <th className="px-3 py-2.5">{t("customers.gstin")}</th>
                <th className="px-3 py-2.5 text-right">Loyalty Points</th>
                <th className="px-3 py-2.5 text-right">{t("common.actions")}</th>
              </tr>
            </thead>
          <tbody>
            {customers.map((c) => (
              <tr
                key={c.id}
                data-testid={`customer-row-${c.id}`}
                className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
              >
                <td className="px-3 py-2 font-medium text-gray-900">{c.name}</td>
                <td className="px-3 py-2 text-gray-600">{c.phone || "—"}</td>
                <td className="px-3 py-2 font-mono text-xs text-gray-500">
                  {c.gstin || "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono font-medium text-purple-700" data-testid={`customer-loyalty-${c.id}`}>
                  {c.loyaltyPoints ?? 0} pts
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      data-testid={`customer-ledger-${c.id}`}
                      className="rounded bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                      onClick={() => setLedgerCustomer(c)}
                    >
                      {t("customers.ledger")}
                    </button>
                    <button
                      type="button"
                      data-testid={`customer-edit-${c.id}`}
                      className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
                      onClick={() => setEditingCustomer(c)}
                    >
                      {t("common.edit")}
                    </button>
                    <button
                      type="button"
                      data-testid={`customer-delete-${c.id}`}
                      className="rounded border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                      onClick={() => void onDelete(c)}
                    >
                      {t("common.delete")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {editingCustomer ? (
        <CustomerDialog
          initial={editingCustomer === "new" ? null : editingCustomer}
          onClose={() => setEditingCustomer(null)}
          onSaved={() => {
            setEditingCustomer(null);
            setVersion((v) => v + 1);
          }}
        />
      ) : null}

      {ledgerCustomer ? (
        <CustomerLedgerDialog
          customer={ledgerCustomer}
          onClose={() => setLedgerCustomer(null)}
        />
      ) : null}
    </div>
  );
}
