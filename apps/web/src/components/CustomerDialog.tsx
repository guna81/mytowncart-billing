// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type FormEvent } from "react";
import type { Customer } from "@mytowncart-billing/storage";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";

const inputCls =
  "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 shadow-2xs";
const labelCls = "block text-sm font-medium text-gray-700";

export interface CustomerDialogProps {
  initial?: Customer | null;
  onClose(): void;
  onSaved(savedId?: number): void;
}

export function CustomerDialog({ initial, onClose, onSaved }: CustomerDialogProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [gstin, setGstin] = useState(initial?.gstin ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("common.name"));
      return;
    }
    const id = await getRepository().upsertCustomer({
      id: initial?.id,
      name: name.trim(),
      phone: phone.trim(),
      gstin: gstin.trim() || undefined,
      address: address.trim() || undefined,
    });
    onSaved(id);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl border border-gray-100"
        data-testid="customer-dialog"
      >
        <h2 className="mb-3 text-base font-semibold text-gray-900">
          {initial ? t("customers.edit") : t("customers.add")}
        </h2>
        <label className={labelCls}>
          {t("common.name")} *
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
        <label className={`${labelCls} mt-3`}>
          {t("customers.gstin")}
          <input
            className={inputCls}
            data-testid="customer-gstin"
            placeholder="e.g. 29ABCDE1234F1Z5"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
          />
        </label>
        <label className={`${labelCls} mt-3`}>
          {t("customers.address")}
          <textarea
            className={`${inputCls} resize-none`}
            rows={2}
            data-testid="customer-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-gray-300 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 text-gray-700"
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            data-testid="customer-save"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 cursor-pointer"
          >
            {t("common.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
