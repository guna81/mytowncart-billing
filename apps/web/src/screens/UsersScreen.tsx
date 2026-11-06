// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type FormEvent } from "react";
import type { User, UserRole } from "@mytowncart-billing/storage";
import { Badge, Button, Input, Modal } from "../components/ui";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";

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
  const [pin, setPin] = useState(initial?.pin ?? "");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("User name is required");
      return;
    }
    if (!pin.trim() || pin.trim().length < 4) {
      setError("PIN must be at least 4 digits");
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
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            data-testid="user-role"
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
          >
            <option value="cashier">{t("users.role.cashier")}</option>
            <option value="owner">{t("users.role.owner")}</option>
          </select>
        </div>

        <Input
          label={`${t("users.pin")} *`}
          type="password"
          maxLength={6}
          data-testid="user-pin"
          placeholder={t("users.pin_ph")}
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

  const load = () => {
    void getRepository().listUsers().then(setUsers);
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold">{t("users.title")}</h1>
        <Button variant="primary" data-testid="users-add" onClick={() => setEditing(null)}>
          + {t("users.add")}
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-gray-600 font-medium">
            <tr>
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">{t("users.name")}</th>
              <th className="px-3 py-2">{t("users.role")}</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u) => (
              <tr key={u.id} data-testid={`user-row-${u.id}`}>
                <td className="px-3 py-2 font-mono text-gray-500">#{u.id}</td>
                <td className="px-3 py-2 font-medium text-gray-900">{u.name}</td>
                <td className="px-3 py-2">
                  <Badge variant={u.role === "owner" ? "purple" : "blue"}>
                    {u.role === "owner" ? t("users.role.owner") : t("users.role.cashier")}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <Badge variant={u.isActive ? "green" : "gray"}>
                    {u.isActive ? "Active" : "Inactive"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    className="text-xs text-blue-600 hover:underline"
                    data-testid={`user-edit-${u.id}`}
                    onClick={() => setEditing(u)}
                  >
                    {t("common.edit")}
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-4 text-center text-gray-500">
                  No users configured yet. Add users to enable cashier quick-lock and supervisor overrides.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
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
