// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { suggestCategories } from "@mytowncart-billing/core";
import type { MarketplaceCategory } from "@mytowncart-billing/connector-mytowncart";
import type { Category, Item } from "@mytowncart-billing/storage";
import { Badge, Button, EmptyState, Input, Modal, PageHeader } from "../components/ui";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { getConnector } from "../lib/marketplace";
import { loadConnection } from "../lib/connection";
import { useAppStore } from "../store/appStore";

export function CategoriesScreen() {
  const dataVersion = useAppStore((s) => s.dataVersion);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);

  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [marketplace, setMarketplace] = useState<MarketplaceCategory[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [name, setName] = useState("");
  const [marketplaceId, setMarketplaceId] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const repo = getRepository();
      const [cats, itms] = await Promise.all([
        repo.listCategories(),
        repo.listItems({ activeOnly: false }),
      ]);
      setCategories(cats);
      setItems(itms);

      try {
        const token = await loadConnection();
        if (token) {
          const connector = getConnector();
          const remoteCats = await connector.listCategories();
          setMarketplace(remoteCats);
        }
      } catch {
        // Marketplace offline or disconnected; mapping remains optional
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData, dataVersion]);

  const itemCounts = useMemo(() => {
    const map = new Map<number, number>();
    for (const item of items) {
      if (item.categoryId !== null) {
        map.set(item.categoryId, (map.get(item.categoryId) ?? 0) + 1);
      }
    }
    return map;
  }, [items]);

  const marketplaceMap = useMemo(() => {
    return new Map<string, string>(marketplace.map((m) => [m.id, m.name]));
  }, [marketplace]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => c.name.toLowerCase().includes(q));
  }, [categories, search]);

  const suggestions = useMemo(() => {
    if (!name.trim() || marketplace.length === 0) return [];
    return suggestCategories(name.trim(), marketplace, 3);
  }, [name, marketplace]);

  const openAddModal = () => {
    setEditingCategory(null);
    setName("");
    setMarketplaceId("");
    setNameError(null);
    setIsModalOpen(true);
  };

  const openEditModal = (cat: Category) => {
    setEditingCategory(cat);
    setName(cat.name);
    setMarketplaceId(cat.marketplaceCategoryId ?? "");
    setNameError(null);
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t("categories.name_required"));
      return;
    }
    const duplicate = categories.some(
      (c) => c.name.toLowerCase() === trimmed.toLowerCase() && c.id !== editingCategory?.id,
    );
    if (duplicate) {
      setNameError(t("categories.name_exists"));
      return;
    }

    setSaving(true);
    setNameError(null);
    try {
      const repo = getRepository();
      const id = await repo.upsertCategory({
        id: editingCategory?.id,
        name: trimmed,
      });

      const nextMarketplaceId = marketplaceId || null;
      if (editingCategory?.marketplaceCategoryId !== nextMarketplaceId) {
        await repo.setCategoryMarketplaceId(id, nextMarketplaceId);
      }

      bumpDataVersion();
      await loadData();
      setIsModalOpen(false);
      setNotice(t("categories.save_success"));
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 pb-24" data-testid="categories-screen">
      <PageHeader
        title={t("categories.title")}
        subtitle={t("categories.subtitle")}
        actions={
          <>
            <Link
              to="/items"
              className="rounded-md border border-gray-300 bg-white px-3.5 py-1.5 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
            >
              ← {t("nav.items")}
            </Link>
            <Button
              type="button"
              variant="primary"
              data-testid="category-add-btn"
              onClick={openAddModal}
            >
              + {t("categories.add")}
            </Button>
          </>
        }
      />

      {notice ? (
        <div
          data-testid="category-notice"
          className="rounded-md border border-green-200 bg-green-50 p-3 text-sm font-medium text-green-800"
        >
          {notice}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-full max-w-sm">
          <Input
            data-testid="categories-search"
            placeholder={t("categories.search_ph")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="text-sm text-gray-600">
          <span className="font-semibold text-gray-900">{categories.length}</span>{" "}
          {t("categories.total").toLowerCase()}
        </div>
      </div>

      {loading && categories.length === 0 ? (
        <p className="text-sm text-gray-500">{t("common.loading")}</p>
      ) : categories.length === 0 ? (
        <EmptyState
          title={t("categories.empty")}
          hint={t("categories.empty_hint")}
          action={
            <Button variant="primary" data-testid="categories-empty-add-btn" onClick={openAddModal}>
              + {t("categories.add")}
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left font-semibold text-gray-700">
                <th className="px-4 py-3">{t("categories.name")}</th>
                <th className="px-4 py-3">{t("categories.items_count")}</th>
                <th className="px-4 py-3">{t("categories.mapping")}</th>
                <th className="px-4 py-3 text-right">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((cat) => {
                const count = itemCounts.get(cat.id) ?? 0;
                const mappedName = cat.marketplaceCategoryId
                  ? marketplaceMap.get(cat.marketplaceCategoryId) ?? cat.marketplaceCategoryId
                  : null;

                return (
                  <tr
                    key={cat.id}
                    className="border-b border-gray-100 last:border-0 hover:bg-gray-50/50"
                    data-testid={`category-row-${cat.id}`}
                  >
                    <td className="px-4 py-3 font-semibold text-gray-900">{cat.name}</td>
                    <td className="px-4 py-3">
                      <Badge variant={count > 0 ? "blue" : "gray"}>
                        {t("categories.items_count_badge", { count })}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {mappedName ? (
                        <Badge variant="green" title={mappedName}>
                          ✓ {mappedName}
                        </Badge>
                      ) : (
                        <Badge variant="gray">{t("categories.unmapped")}</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        data-testid={`category-edit-${cat.id}`}
                        onClick={() => openEditModal(cat)}
                      >
                        {t("common.edit")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && search.trim() ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-sm text-gray-500">
                    No categories matching &quot;{search}&quot;
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / Edit Category Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingCategory ? t("categories.edit_dialog_title") : t("categories.new_dialog_title")}
        dataTestId="category-modal"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
          className="space-y-4"
        >
          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1">
              {t("categories.name")} *
            </label>
            <input
              autoFocus
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="e.g. Snacks, Beverages, Dairy"
              data-testid="category-modal-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
            />
            {nameError ? (
              <p className="mt-1 text-xs text-red-600 font-medium" data-testid="category-modal-error">
                {nameError}
              </p>
            ) : null}
          </div>

          {marketplace.length > 0 ? (
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-1">
                {t("categories.marketplace_category")}
              </label>
              <select
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-2xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                data-testid="category-modal-marketplace"
                value={marketplaceId}
                onChange={(e) => setMarketplaceId(e.target.value)}
              >
                <option value="">{t("categories.select_marketplace")}</option>
                {marketplace.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>

              {suggestions.length > 0 && !marketplaceId ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
                  <span>Suggested:</span>
                  {suggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="rounded bg-blue-50 px-2 py-0.5 text-blue-700 hover:bg-blue-100"
                      onClick={() => setMarketplaceId(s.id)}
                    >
                      + {s.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-5 flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsModalOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              data-testid="category-modal-save"
            >
              {t("common.save")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
