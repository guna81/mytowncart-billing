// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type FormEvent } from "react";
import type { Supplier } from "@mytowncart-billing/storage";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { Button, Input, Modal, EmptyState, PageHeader } from "../components/ui";

function SupplierDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Supplier | null;
  onClose(): void;
  onSaved(): void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [gstin, setGstin] = useState(initial?.gstin ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("suppliers.name") + " is required");
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await getRepository().upsertSupplier({
        id: initial?.id,
        name: name.trim(),
        phone: phone.trim(),
        gstin: gstin.trim(),
        address: address.trim(),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={initial ? t("suppliers.edit") : t("suppliers.add")}
      dataTestId="supplier-dialog"
    >
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-3">
        <Input
          label={`${t("suppliers.name")} *`}
          autoFocus
          data-testid="supplier-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label={t("suppliers.phone")}
          data-testid="supplier-phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Input
          label={t("suppliers.gstin")}
          data-testid="supplier-gstin"
          value={gstin}
          onChange={(e) => setGstin(e.target.value)}
        />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t("suppliers.address")}
          </label>
          <textarea
            rows={2}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            data-testid="supplier-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>

        {error ? <p className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2 pt-2 border-t border-gray-100">
          <Button variant="secondary" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" data-testid="supplier-submit" disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function SuppliersScreen() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Supplier | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    void getRepository()
      .listSuppliers(search || undefined)
      .then(setSuppliers);
  };

  useEffect(() => {
    load();
  }, [search]);

  const onDelete = async (s: Supplier) => {
    if (!window.confirm(t("suppliers.delete_confirm", { name: s.name }))) return;
    try {
      setError(null);
      await getRepository().deleteSupplier(s.id);
      load();
    } catch {
      setError(t("suppliers.delete_has_purchases"));
    }
  };

  return (
    <div>
      <PageHeader
        title={t("suppliers.title")}
        actions={
          <Button
            variant="primary"
            data-testid="suppliers-add"
            onClick={() => setEditing(null)}
          >
            + {t("suppliers.add")}
          </Button>
        }
      />

      <div className="mb-4">
        <input
          type="text"
          className="w-full max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          data-testid="suppliers-search"
          placeholder={t("suppliers.search_ph")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error ? (
        <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 border border-red-200">
          {error}
        </div>
      ) : null}

      {suppliers.length === 0 ? (
        <EmptyState
          title={t("suppliers.empty")}
          hint={t("suppliers.empty_hint")}
          action={
            <Button
              variant="primary"
              onClick={() => setEditing(null)}
            >
              + {t("suppliers.add")}
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-gray-700 font-semibold">
              <tr>
                <th className="px-3 py-2.5">{t("suppliers.name")}</th>
                <th className="px-3 py-2.5">{t("suppliers.phone")}</th>
                <th className="px-3 py-2.5">{t("suppliers.gstin")}</th>
                <th className="px-3 py-2.5">{t("suppliers.address")}</th>
                <th className="px-3 py-2.5 text-right">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {suppliers.map((s) => (
                <tr key={s.id} data-testid={`supplier-row-${s.id}`} className="hover:bg-gray-50">
                  <td className="px-3 py-2.5 font-medium text-gray-900">{s.name}</td>
                  <td className="px-3 py-2.5 font-mono text-gray-600">{s.phone || "—"}</td>
                  <td className="px-3 py-2.5 font-mono text-gray-600">{s.gstin || "—"}</td>
                  <td className="px-3 py-2.5 text-gray-600 max-w-xs truncate">{s.address || "—"}</td>
                  <td className="px-3 py-2.5 text-right space-x-2">
                    <button
                      type="button"
                      className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline"
                      data-testid={`supplier-edit-${s.id}`}
                      onClick={() => setEditing(s)}
                    >
                      {t("common.edit")}
                    </button>
                    <button
                      type="button"
                      className="text-xs font-medium text-red-600 hover:text-red-800 hover:underline"
                      data-testid={`supplier-delete-${s.id}`}
                      onClick={() => void onDelete(s)}
                    >
                      {t("common.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing !== undefined ? (
        <SupplierDialog
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      ) : null}
    </div>
  );
}
