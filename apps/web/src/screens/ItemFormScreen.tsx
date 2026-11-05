// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  checkImage,
  formatPaise,
  formatQty,
  IMAGE_MIME,
  imageHash,
  isUnitKind,
  parsePaise,
  parseQty,
  UNIT_KINDS,
  type UnitKind,
} from "@mytowncart-billing/core";
import type { Category } from "@mytowncart-billing/storage";
import { t, type I18nKey } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

const inputCls = "mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm";
const labelCls = "block text-sm font-medium text-gray-700";

export function ItemFormScreen() {
  const { id } = useParams();
  const editId = id === undefined ? null : Number(id);
  const navigate = useNavigate();
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);

  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [newCategory, setNewCategory] = useState("");
  const [unitKind, setUnitKind] = useState<UnitKind>("count");
  const [price, setPrice] = useState("");
  const [mrp, setMrp] = useState("");
  const [taxPercent, setTaxPercent] = useState("0");
  const [openingStock, setOpeningStock] = useState("0");
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoUploadedAt, setPhotoUploadedAt] = useState<string | null>(null);

  const loadPhoto = async (itemId: number) => {
    const photo = await getRepository().readItemPhoto(itemId);
    setPhotoUrl(
      photo ? URL.createObjectURL(new Blob([photo.bytes as BlobPart], { type: "image/*" })) : null,
    );
    const item = await getRepository().getItem(itemId);
    setPhotoUploadedAt(item?.imageUploadedAt ?? null);
  };

  useEffect(() => {
    return () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    };
  }, [photoUrl]);

  useEffect(() => {
    void (async () => {
      const repo = getRepository();
      setCategories(await repo.listCategories());
      if (editId !== null) {
        const item = await repo.getItem(editId);
        if (item?.photoFile) await loadPhoto(editId);
        if (item) {
          setName(item.name);
          setBarcode(item.barcode);
          setCategoryId(item.categoryId);
          setUnitKind(item.unitKind);
          setPrice(formatPaise(item.pricePaise));
          setMrp(formatPaise(item.mrpPaise));
          setTaxPercent((item.taxRateBp / 100).toString());
          setOpeningStock("0");
          setIsActive(item.isActive);
        }
      }
    })();
  }, [editId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const pricePaise = parsePaise(price || "0");
    const mrpPaise = parsePaise(mrp || "0");
    const taxBp = Math.round(Number(taxPercent || "0") * 100);
    const openingMilli = parseQty(openingStock || "0");
    if (name.trim() === "") return setError(t("items.row", { row: "—", message: "name is required" }));
    if (pricePaise === null || pricePaise < 0) return setError(`price: ${price}`);
    if (mrpPaise === null || mrpPaise < 0) return setError(`mrp: ${mrp}`);
    if (!Number.isFinite(taxBp) || taxBp < 0 || taxBp > 10_000) return setError(`tax: ${taxPercent}`);
    if (openingMilli === null) return setError(`opening stock: ${openingStock}`);

    setBusy(true);
    try {
      const repo = getRepository();
      let finalCategoryId = categoryId;
      if (finalCategoryId === null && newCategory.trim() !== "") {
        finalCategoryId = await repo.upsertCategory({ name: newCategory.trim() });
      }
      await repo.upsertItem({
        id: editId ?? undefined,
        name: name.trim(),
        barcode: barcode.trim(),
        categoryId: finalCategoryId,
        unitKind,
        pricePaise,
        mrpPaise,
        taxRateBp: taxBp,
        openingStockMilli: editId === null ? openingMilli : 0,
        isActive,
      });
      bumpDataVersion();
      navigate("/items");
    } catch (err) {
      setError(t("common.error", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const onPhotoFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || editId === null) return;
    setError(null);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkImage(file, bytes.subarray(0, 12));
    if (!check.ok || check.kind === null) {
      setError(t(`item_form.photo_error.${check.error ?? "not_an_image"}` as I18nKey));
      return;
    }
    const hash = await imageHash(bytes);
    if (hash === null) {
      setError(t("common.error", { message: "this browser cannot verify photos" }));
      return;
    }
    await getRepository().setItemPhoto(editId, bytes, hash);
    await loadPhoto(editId);
    bumpDataVersion();
  };

  const removePhoto = async () => {
    if (editId === null) return;
    await getRepository().clearItemPhoto(editId);
    await loadPhoto(editId);
    bumpDataVersion();
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="max-w-lg space-y-4">
      <h1 className="text-lg font-bold">
        {t(editId === null ? "item_form.add_title" : "item_form.edit_title")}
      </h1>

      <label className={labelCls}>
        {t("item_form.name")}
        <input data-testid="item-name" className={inputCls} value={name} autoFocus
          onChange={(e) => setName(e.target.value)} />
      </label>

      <label className={labelCls}>
        {t("item_form.barcode")}
        <input data-testid="item-barcode" className={`${inputCls} font-mono`} value={barcode}
          onChange={(e) => setBarcode(e.target.value)} />
        <span className="text-xs text-gray-500">{t("item_form.barcode_hint")}</span>
      </label>

      <div className="grid grid-cols-2 gap-4">
        <label className={labelCls}>
          {t("item_form.category")}
          <select
            className={inputCls}
            value={categoryId ?? ""}
            onChange={(e) => setCategoryId(e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">{t("common.none")}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          &nbsp;
          <input className={inputCls} placeholder={t("item_form.new_category_ph")}
            value={newCategory} onChange={(e) => setNewCategory(e.target.value)} />
        </label>
      </div>

      <label className={labelCls}>
        {t("item_form.unit_kind")}
        <select
          data-testid="item-unit-kind"
          className={inputCls}
          value={unitKind}
          onChange={(e) => {
            const v = e.target.value;
            if (isUnitKind(v)) setUnitKind(v);
          }}
        >
          {UNIT_KINDS.map((k) => (
            <option key={k} value={k}>{t(`item_form.unit.${k}`)}</option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-3 gap-4">
        <label className={labelCls}>
          {t("item_form.price")}
          <input data-testid="item-price" className={inputCls} inputMode="decimal" value={price}
            onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className={labelCls}>
          {t("item_form.mrp")}
          <input className={inputCls} inputMode="decimal" value={mrp}
            onChange={(e) => setMrp(e.target.value)} />
        </label>
        <label className={labelCls}>
          {t("item_form.tax_rate")}
          <input className={inputCls} inputMode="decimal" value={taxPercent}
            onChange={(e) => setTaxPercent(e.target.value)} />
        </label>
      </div>

      {editId === null ? (
        <label className={labelCls}>
          {t("item_form.opening_stock")}
          <input data-testid="item-opening-stock" className={inputCls} inputMode="decimal"
            value={openingStock} onChange={(e) => setOpeningStock(e.target.value)} />
          <span className="text-xs text-gray-500">{t("item_form.opening_stock_hint")}</span>
        </label>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        {t("item_form.is_active")}
      </label>

      <div data-testid="item-photo">
        <span className={labelCls}>{t("item_form.photo")}</span>
        <div className="mt-1 flex items-center gap-3">
          <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded border border-gray-200 bg-gray-50">
            {photoUrl ? (
              <img src={photoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-xs text-gray-400">{t("common.none")}</span>
            )}
          </div>
          {editId === null ? (
            <p className="text-sm text-gray-500">{t("item_form.photo_save_first")}</p>
          ) : (
            <div className="space-y-2">
              <label className="inline-block cursor-pointer rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50">
                {photoUrl ? t("item_form.photo_replace") : t("item_form.photo_choose")}
                <input
                  type="file"
                  accept={Object.values(IMAGE_MIME).join(",")}
                  className="hidden"
                  data-testid="item-photo-input"
                  onChange={(e) => void onPhotoFile(e)}
                />
              </label>
              {photoUrl ? (
                <button
                  type="button"
                  className="block text-sm text-red-600"
                  data-testid="item-photo-remove"
                  onClick={() => void removePhoto()}
                >
                  {t("item_form.photo_remove")}
                </button>
              ) : null}
              {photoUploadedAt ? (
                <p className="text-xs text-green-700">{t("item_form.photo_uploaded")}</p>
              ) : null}
            </div>
          )}
        </div>
        <p className="mt-1 text-xs text-gray-500">{t("item_form.photo_hint")}</p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="flex gap-2">
        <button
          type="submit"
          data-testid="item-save"
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {t("common.save")}
        </button>
        <button
          type="button"
          className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
          onClick={() => navigate("/items")}
        >
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

export function formatQtyForInput(milli: number): string {
  return formatQty(milli);
}
