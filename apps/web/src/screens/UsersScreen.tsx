// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type FormEvent } from "react";
import type { AuditLog, User, UserRole } from "@mytowncart-billing/storage";
import { Badge, Button, Input, Modal, EmptyState, PageHeader } from "../components/ui";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { refreshLoginState } from "../lib/roles";

function UserDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial?: User | null;
  onClose(): void;
  onSaved(): void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState<UserRole>(initial?.role ?? "cashier");
  const [pin, setPin] = useState("");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("User name is required");
      return;
    }
    // Editing: a blank PIN keeps the current one. New users need a 4–6 digit PIN.
    const pinText = pin.trim();
    if ((!initial || pinText !== "") && !/^\d{4,6}$/.test(pinText)) {
      setError("PIN must be 4 to 6 digits");
      return;
    }

    try {
      setSaving(true);
      setError(null);
      await getRepository().upsertUser({
        id: initial?.id,
        name: name.trim(),
        role,
        pin: pin.trim(),
        isActive,
      });
      await refreshLoginState();
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
      title={initial ? "Edit User" : t("users.add")}
      dataTestId="user-dialog"
    >
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
        <Input
          label={`${t("users.name")} *`}
          autoFocus
          data-testid="user-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t("users.role")}</label>
          <select
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-2xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            data-testid="user-role"
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
          >
            <option value="cashier">{t("users.role.cashier")}</option>
            <option value="owner">{t("users.role.owner")}</option>
          </select>
        </div>

        <Input
          label={initial ? t("users.pin") : `${t("users.pin")} *`}
          type="password"
          maxLength={6}
          data-testid="user-pin"
          placeholder={initial ? t("users.pin_keep_ph") : t("users.pin_ph")}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="user-active"
            data-testid="user-active"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <label htmlFor="user-active" className="text-sm font-medium text-gray-700">
            {t("users.active")}
          </label>
        </div>

        {error ? <p className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2 pt-2 border-t border-gray-100">
          <Button variant="secondary" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" data-testid="user-submit" disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function UsersScreen() {
  const [users, setUsers] = useState<User[]>([]);
  const [editing, setEditing] = useState<User | null | undefined>(undefined);
  const [logs, setLogs] = useState<AuditLog[]>([]);

  const load = () => {
    void getRepository().listUsers().then(setUsers);
    // Owner-only; a cashier never reaches this screen, and a failure just leaves the list empty.
    void getRepository().listAuditLogs(50).then(setLogs).catch(() => setLogs([]));
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <PageHeader
        title={t("users.title")}
        actions={
          <Button variant="primary" data-testid="users-add" onClick={() => setEditing(null)}>
            + {t("users.add")}
          </Button>
        }
      />

      {users.length === 0 ? (
        <EmptyState
          title={t("users.empty")}
          hint={t("users.empty_hint")}
          action={
            <Button variant="primary" onClick={() => setEditing(null)}>
              + {t("users.add")}
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-gray-700 font-semibold">
              <tr>
                <th className="px-3 py-2.5">ID</th>
                <th className="px-3 py-2.5">{t("users.name")}</th>
                <th className="px-3 py-2.5">{t("users.role")}</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5 text-right">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id} data-testid={`user-row-${u.id}`} className="hover:bg-gray-50">
                  <td className="px-3 py-2.5 font-mono text-gray-600">#{u.id}</td>
                  <td className="px-3 py-2.5 font-medium text-gray-900">{u.name}</td>
                  <td className="px-3 py-2.5">
                    <Badge variant={u.role === "owner" ? "purple" : "blue"}>
                      {u.role === "owner" ? t("users.role.owner") : t("users.role.cashier")}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant={u.isActive ? "green" : "gray"}>
                      {u.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      type="button"
                      className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline"
                      data-testid={`user-edit-${u.id}`}
                      onClick={() => setEditing(u)}
                    >
                      {t("common.edit")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt-8 mb-2 text-sm font-semibold text-gray-800">{t("users.audit_title")}</h2>
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm" data-testid="audit-log">
        {logs.length === 0 ? (
          <p className="p-3 text-sm text-gray-500">{t("users.audit_empty")}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-100">
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-2 font-mono text-xs text-gray-500 whitespace-nowrap">
                    {l.createdAt.slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="px-3 py-2 font-medium text-gray-900">{l.userName ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-700">{l.action}</td>
                  <td className="px-3 py-2 text-gray-600">{l.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing !== undefined ? (
        <UserDialog
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
