// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
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
  groupMarketplaceCategories,
  suggestCategoryForItem,
  UNIT_KINDS,
  type UnitKind,
} from "@mytowncart-billing/core";
import type { Category, Item, ItemBarcode } from "@mytowncart-billing/storage";
import { PageHeader } from "../components/ui";
import { t, type I18nKey } from "../i18n";
import { looksLikeHtml, plainToHtml, richTextToPlain } from "../lib/richText";
import { triggerImmediateSync } from "../lib/autoSync";
import { loadConnection } from "../lib/connection";
import { getConnector } from "../lib/marketplace";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";
import { VariantEditor } from "./itemForm/VariantEditor";
import { baseNameOf, newVariantGroup, variantItemName, type VariantRow } from "./itemForm/variants";

const inputCls = "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 shadow-2xs";
const labelCls = "block text-sm font-semibold text-gray-800";

export function ItemFormScreen() {
  const { id } = useParams();
  const editId = id === undefined ? null : Number(id);
  const navigate = useNavigate();
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);

  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [brand, setBrand] = useState("");
  const [description, setDescription] = useState("");
  const originalDescription = useRef({ stored: "", text: "" });
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [newCategory, setNewCategory] = useState("");
  // MyTownCart categories (only when this shop is connected) and the seller's pick.
  const [mtcCategories, setMtcCategories] = useState<{ id: string; name: string; parentId: string | null }[]>([]);
  const [mtcChoice, setMtcChoice] = useState<string>("");
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [unitKind, setUnitKind] = useState<UnitKind>("count");
  const [price, setPrice] = useState("");
  const [mrp, setMrp] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [hsnCode, setHsnCode] = useState("");
  const [taxPercent, setTaxPercent] = useState("0");
  const [openingStock, setOpeningStock] = useState("0");
  const [isActive, setIsActive] = useState(true);
  const [customAttributes, setCustomAttributes] = useState<{ key: string; value: string }[]>([]);
  // Sizes/options: more than one row means this product is sold as variants.
  const [variantRows, setVariantRows] = useState<VariantRow[]>([]);
  const [variantGroup, setVariantGroup] = useState("");
  const [loadedIsPlain, setLoadedIsPlain] = useState(false);
  // A plain item already on MyTownCart can't become a group without a duplicate listing there.
  const [loadedPublished, setLoadedPublished] = useState(false);
  const [plainStock, setPlainStock] = useState("0");
  const originalSiblings = useRef<Item[]>([]);
  const hasVariants = variantRows.length > 1;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<
    {
      id: string | number;
      url: string;
      bytes?: Uint8Array;
      hash: string;
      isMain: boolean;
      imageUploadedAt: string | null;
    }[]
  >([]);
  const photosRef = useRef(photos);
  photosRef.current = photos;

  // Secondary Barcodes
  const [secondaryBarcodes, setSecondaryBarcodes] = useState<ItemBarcode[]>([]);
  const [newSecBarcode, setNewSecBarcode] = useState("");
  const [newSecQty, setNewSecQty] = useState("1");
  const [newSecLabel, setNewSecLabel] = useState("");
  const [secError, setSecError] = useState<string | null>(null);

  const loadBarcodes = async (itemId: number) => {
    const list = await getRepository().listItemBarcodes(itemId);
    setSecondaryBarcodes(list);
  };

  const addSecondaryBarcode = async () => {
    if (!editId) return;
    const trimmed = newSecBarcode.trim();
    if (!trimmed) {
      setSecError("Barcode cannot be empty");
      return;
    }
    const packQty = parseFloat(newSecQty);
    if (isNaN(packQty) || packQty <= 0) {
      setSecError("Pack quantity must be > 0");
      return;
    }
    setSecError(null);
    try {
      await getRepository().upsertItemBarcode(
        editId,
        trimmed,
        Math.round(packQty * 1000),
        newSecLabel.trim(),
      );
      setNewSecBarcode("");
      setNewSecQty("1");
      setNewSecLabel("");
      await loadBarcodes(editId);
    } catch (err) {
      setSecError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeSecondaryBarcode = async (barcodeId: number) => {
    if (!editId) return;
    await getRepository().deleteItemBarcode(barcodeId);
    await loadBarcodes(editId);
  };

  const loadPhotos = async (itemId: number) => {
    const repo = getRepository();
    for (const p of photosRef.current) {
      URL.revokeObjectURL(p.url);
    }
    const itemImages = await repo.listItemImages(itemId);
    if (itemImages.length > 0) {
      const loaded = [];
      for (const img of itemImages) {
        const photo = await repo.readItemImage(img.id);
        if (photo) {
          const url = URL.createObjectURL(new Blob([photo.bytes as BlobPart], { type: "image/*" }));
          loaded.push({
            id: img.id,
            url,
            hash: img.imageHash,
            isMain: img.isMain,
            imageUploadedAt: img.imageUploadedAt,
          });
        }
      }
      setPhotos(loaded);
    } else {
      const legacyPhoto = await repo.readItemPhoto(itemId);
      const item = await repo.getItem(itemId);
      if (legacyPhoto) {
        const url = URL.createObjectURL(new Blob([legacyPhoto.bytes as BlobPart], { type: "image/*" }));
        setPhotos([
          {
            id: "legacy",
            url,
            hash: legacyPhoto.imageHash ?? "",
            isMain: true,
            imageUploadedAt: item?.imageUploadedAt ?? null,
          },
        ]);
      } else {
        setPhotos([]);
      }
    }
  };

  useEffect(() => {
    return () => {
      for (const p of photosRef.current) {
        URL.revokeObjectURL(p.url);
      }
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        if ((await loadConnection()) !== null) setMtcCategories(await getConnector().listCategories());
      } catch {
        setMtcCategories([]); // offline or not connected: the picker simply stays hidden
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const repo = getRepository();
      setCategories(await repo.listCategories());
      if (editId !== null) {
        await loadBarcodes(editId);
        await loadPhotos(editId);
        const item = await repo.getItem(editId);
        if (item) {
          if (item.variantGroup) {
            const siblings = (await repo.listItems({})).filter((i) => i.variantGroup === item.variantGroup);
            siblings.sort((a, b) => a.id - b.id);
            originalSiblings.current = siblings;
            setVariantGroup(item.variantGroup);
            setVariantRows(
              siblings.map((i) => ({
                id: i.id,
                options: i.variantOptions,
                price: formatPaise(i.pricePaise),
                mrp: formatPaise(i.mrpPaise),
                cost: i.costPricePaise ? formatPaise(i.costPricePaise) : "",
                stock: formatQty(i.stockMilli),
                barcode: i.barcode,
              })),
            );
            setName(baseNameOf(item.name, item.variantOptions));
          } else {
            setLoadedIsPlain(true);
            setLoadedPublished(item.remoteProductId !== null);
            setPlainStock(formatQty(item.stockMilli));
            setName(item.name);
          }
          setBarcode(item.barcode);
          setBrand(item.brand ?? "");
          const stored = item.description ?? "";
          const text = looksLikeHtml(stored) ? richTextToPlain(stored) : stored;
          originalDescription.current = { stored, text };
          setDescription(text);
          setCategoryId(item.categoryId);
          setUnitKind(item.unitKind);
          setPrice(formatPaise(item.pricePaise));
          setMrp(formatPaise(item.mrpPaise));
          setCostPrice(item.costPricePaise ? formatPaise(item.costPricePaise) : "");
          setHsnCode(item.hsnCode ?? "");
          setTaxPercent((item.taxRateBp / 100).toString());
          setOpeningStock("0");
          setIsActive(item.isActive);
          const attrs = Object.entries(item.customAttributes ?? {}).map(([key, value]) => ({
            key,
            value,
          }));
          setCustomAttributes(attrs);
        }
      }
    })();
  }, [editId]);

  const mtcGroups = useMemo(() => groupMarketplaceCategories(mtcCategories), [mtcCategories]);
  // What the chosen local category is already mapped to, shown as the empty option.
  const mappedMtcName = useMemo(() => {
    const mappedId = categories.find((c) => c.id === categoryId)?.marketplaceCategoryId;
    return mtcCategories.find((c) => c.id === mappedId)?.name ?? null;
  }, [categories, categoryId, mtcCategories]);
  const mtcSuggestion = useMemo(
    () => (name.trim() === "" || mappedMtcName !== null ? null : suggestCategoryForItem(name, mtcCategories)),
    [name, mappedMtcName, mtcCategories],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const pricePaise = parsePaise(price || "0");
    const mrpPaise = parsePaise(mrp || "0");
    const taxBp = Math.round(Number(taxPercent || "0") * 100);
    const openingMilli = parseQty(openingStock || "0");
    if (name.trim() === "") return setError(t("items.row", { row: "—", message: "name is required" }));
    if (!hasVariants && (pricePaise === null || pricePaise < 0)) return setError(`price: ${price}`);
    if (mrpPaise === null || mrpPaise < 0) return setError(`mrp: ${mrp}`);
    if (!Number.isFinite(taxBp) || taxBp < 0 || taxBp > 10_000) return setError(`tax: ${taxPercent}`);
    if (!hasVariants && openingMilli === null) return setError(`opening stock: ${openingStock}`);
    if (hasVariants) {
      const bad = variantRows.some((r) => {
        const p = parsePaise(r.price || "");
        const m = parsePaise(r.mrp || "0");
        const c = parsePaise(r.cost || "0");
        return p === null || p < 0 || m === null || m < 0 || c === null || c < 0 || (r.id === undefined && parseQty(r.stock || "0") === null);
      });
      if (bad) return setError(t("item_form.variants.error_price"));
    }

    setBusy(true);
    try {
      const repo = getRepository();
      let finalCategoryId = categoryId;
      if (finalCategoryId === null && newCategory.trim() !== "") {
        finalCategoryId = await repo.upsertCategory({ name: newCategory.trim() });
      }
      // A MyTownCart category was picked: reuse (or create) the local category of
      // that name and map it, so the item can be published without a second step.
      const mtcPick = mtcCategories.find((c) => c.id === mtcChoice);
      if (mtcPick) {
        if (finalCategoryId === null) {
          const match =
            categories.find((c) => c.marketplaceCategoryId === mtcPick.id) ??
            categories.find((c) => c.name.trim().toLowerCase() === mtcPick.name.trim().toLowerCase());
          finalCategoryId = match?.id ?? (await repo.upsertCategory({ name: mtcPick.name.trim() }));
        }
        await repo.setCategoryMarketplaceId(finalCategoryId, mtcPick.id);
      }
      const costPricePaise = costPrice ? (parsePaise(costPrice) ?? 0) : 0;

      const finalAttributes: Record<string, string> = {};
      for (const attr of customAttributes) {
        const k = attr.key.trim();
        const v = attr.value.trim();
        if (k) {
          finalAttributes[k] = v;
        }
      }

      if (hasVariants) {
        const group = variantGroup || newVariantGroup();
        const common = {
          brand: brand.trim(),
          description: description === originalDescription.current.text
            ? originalDescription.current.stored
            : plainToHtml(description),
          customAttributes: finalAttributes,
          categoryId: finalCategoryId,
          unitKind,
          taxRateBp: taxBp,
          hsnCode: hsnCode.trim(),
          costPricePaise,
          variantGroup: group,
        };
        const keptIds = new Set<number>();
        for (const r of variantRows) {
          const id = await repo.upsertItem({
            ...common,
            id: r.id,
            name: variantItemName(name, r.options),
            barcode: r.barcode.trim(),
            pricePaise: parsePaise(r.price) ?? 0,
            mrpPaise: parsePaise(r.mrp || "0") ?? 0,
            costPricePaise: r.cost.trim() ? (parsePaise(r.cost) ?? 0) : costPricePaise,
            openingStockMilli: r.id === undefined ? (parseQty(r.stock || "0") ?? 0) : 0,
            isActive,
            variantOptions: r.options,
          });
          keptIds.add(id);
        }
        // Options taken off the list stop being sold; the items stay for bill history.
        for (const old of originalSiblings.current) {
          if (keptIds.has(old.id)) continue;
          await repo.upsertItem({
            ...common,
            id: old.id,
            name: old.name,
            barcode: old.barcode,
            pricePaise: old.pricePaise,
            mrpPaise: old.mrpPaise,
            costPricePaise: old.costPricePaise,
            openingStockMilli: 0,
            isActive: false,
            variantOptions: old.variantOptions,
          });
        }
        bumpDataVersion();
        triggerImmediateSync();
        navigate("/items");
        return;
      }

      if (pricePaise === null || openingMilli === null) return; // unreachable: validated above
      const savedItemId = await repo.upsertItem({
        id: editId ?? undefined,
        name: name.trim(),
        barcode: barcode.trim(),
        brand: brand.trim(),
        description: description === originalDescription.current.text
          ? originalDescription.current.stored
          : plainToHtml(description),
        customAttributes: finalAttributes,
        categoryId: finalCategoryId,
        unitKind,
        pricePaise,
        mrpPaise,
        taxRateBp: taxBp,
        openingStockMilli: editId === null ? openingMilli : 0,
        isActive,
        hsnCode: hsnCode.trim(),
        costPricePaise,
      });

      if (editId === null && photos.length > 0) {
        for (const p of photos) {
          if (p.bytes) {
            await repo.addItemImage(savedItemId, p.bytes, p.hash, p.isMain);
          }
        }
      }

      bumpDataVersion();
      triggerImmediateSync();
      navigate("/items");
    } catch (err) {
      setError(t("common.error", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const onPhotoFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setError(null);

    const validNewPhotos: { bytes: Uint8Array; hash: string }[] = [];
    for (const file of files) {
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
      validNewPhotos.push({ bytes, hash });
    }

    if (editId !== null) {
      for (let i = 0; i < validNewPhotos.length; i++) {
        const p = validNewPhotos[i];
        if (!p) continue;
        const isFirst = photos.length === 0 && i === 0;
        await getRepository().addItemImage(editId, p.bytes, p.hash, isFirst);
      }
      await loadPhotos(editId);
      bumpDataVersion();
    } else {
      const added = validNewPhotos.map((p, idx) => ({
        id: `pending-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        url: URL.createObjectURL(new Blob([p.bytes as BlobPart], { type: "image/*" })),
        bytes: p.bytes,
        hash: p.hash,
        isMain: photos.length === 0 && idx === 0,
        imageUploadedAt: null,
      }));
      setPhotos((prev) => [...prev, ...added]);
    }
  };

  const setAsMain = async (photo: { id: string | number; isMain: boolean }) => {
    if (editId !== null && typeof photo.id === "number") {
      await getRepository().setItemImageMain(photo.id);
      await loadPhotos(editId);
      bumpDataVersion();
    } else {
      setPhotos((prev) =>
        prev.map((p) => ({
          ...p,
          isMain: p.id === photo.id,
        })),
      );
    }
  };

  const removePhoto = async (photo?: { id: string | number; isMain: boolean; url: string }) => {
    const target = photo ?? photos[0];
    if (!target) return;
    if (editId !== null && typeof target.id === "number") {
      await getRepository().deleteItemImage(target.id);
      await loadPhotos(editId);
      bumpDataVersion();
    } else if (editId !== null && target.id === "legacy") {
      await getRepository().clearItemPhoto(editId);
      await loadPhotos(editId);
      bumpDataVersion();
    } else {
      URL.revokeObjectURL(target.url);
      setPhotos((prev) => {
        const next = prev.filter((p) => p.id !== target.id);
        if (target.isMain && next[0]) {
          next[0].isMain = true;
        }
        return [...next];
      });
    }
  };

  return (
    <div className="max-w-4xl mx-auto pb-24">
      <PageHeader
        title={
          editId !== null ? (
            <span className="inline-flex items-baseline gap-2">
              <span>{t("item_form.edit_title")}</span>
              <span className="text-xl font-normal text-gray-500">#{editId}</span>
            </span>
          ) : (
            t("item_form.add_title")
          )
        }
      />

      <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-6">
        {/* Card 1: Basics */}
        <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-xs space-y-4">
          <h2 className="text-base font-bold text-gray-900 border-b border-gray-100 pb-2.5">
            {t("item_form.section.basics")}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className={labelCls}>
              <span className="flex items-center gap-1">
                {t("item_form.name")}
                <span className="text-red-500 font-bold">*</span>
              </span>
              <input
                data-testid="item-name"
                className={inputCls}
                value={name}
                autoFocus
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            {!hasVariants && (
            <label className={labelCls}>
              <span className="flex items-center justify-between">
                <span>{t("item_form.barcode")}</span>
                <span className="text-xs text-gray-600 font-normal">{t("item_form.optional")}</span>
              </span>
              <input
                data-testid="item-barcode"
                className={`${inputCls} font-mono`}
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
              />
              <span className="text-xs text-gray-600 mt-1 block">{t("item_form.barcode_hint")}</span>
            </label>
            )}

            <label className={labelCls}>
              <span className="flex items-center justify-between">
                <span>{t("item_form.brand")}</span>
                <span className="text-xs text-gray-600 font-normal">{t("item_form.optional")}</span>
              </span>
              <input
                data-testid="item-brand"
                className={inputCls}
                placeholder={t("item_form.brand_hint")}
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
              />
            </label>

            <label className={labelCls}>
              <span className="flex items-center justify-between">
                <span>{t("item_form.category")}</span>
                <span className="text-xs text-gray-600 font-normal">{t("item_form.optional")}</span>
              </span>
              <select
                className={inputCls}
                value={isCreatingCategory ? "__NEW__" : (categoryId ?? "")}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__NEW__") {
                    setIsCreatingCategory(true);
                    setCategoryId(null);
                  } else {
                    setIsCreatingCategory(false);
                    setNewCategory("");
                    setCategoryId(v === "" ? null : Number(v));
                  }
                }}
              >
                <option value="">{t("common.none")}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
                <option value="__NEW__">{t("item_form.category_create")}</option>
              </select>
              {isCreatingCategory && (
                <input
                  className={`${inputCls} mt-2`}
                  placeholder={t("item_form.new_category_ph")}
                  value={newCategory}
                  autoFocus
                  onChange={(e) => setNewCategory(e.target.value)}
                />
              )}
            </label>

            {mtcCategories.length > 0 && (
              <label className={labelCls}>
                <span className="flex items-center justify-between">
                  <span>{t("item_form.mtc_category")}</span>
                  {mtcSuggestion && mtcChoice === "" && (
                    <button
                      type="button"
                      className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-normal text-blue-800 hover:bg-blue-100"
                      onClick={() => setMtcChoice(mtcSuggestion.id)}
                    >
                      {t("mtc.use_suggestion", { name: mtcSuggestion.name })}
                    </button>
                  )}
                </span>
                <select
                  data-testid="item-mtc-category"
                  className={inputCls}
                  value={mtcChoice}
                  // A mapped local category keeps its mapping (it covers other items too).
                  disabled={mappedMtcName !== null}
                  onChange={(e) => setMtcChoice(e.target.value)}
                >
                  <option value="">{mappedMtcName ?? t("common.none")}</option>
                  {mtcGroups.map((g) => {
                    const opts = g.options.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ));
                    return g.label === null ? opts : <optgroup key={g.label} label={g.label}>{opts}</optgroup>;
                  })}
                </select>
                <span className="mt-1 block text-xs font-normal text-gray-600">{t("item_form.mtc_category_hint")}</span>
              </label>
            )}

            <label className={labelCls}>
              <span>{t("item_form.unit_kind")}</span>
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

            <label className={`${labelCls} md:col-span-2`}>
              <span className="flex items-center justify-between">
                <span>{t("item_form.description")}</span>
                <span className="text-xs text-gray-600 font-normal">{t("item_form.optional")}</span>
              </span>
              <textarea
                className={inputCls}
                rows={4}
                data-testid="item-description"
                placeholder={t("item_form.description_hint")}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
          </div>
        </section>

        {/* Card 2: Pricing */}
        <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-xs space-y-4">
          <h2 className="text-base font-bold text-gray-900 border-b border-gray-100 pb-2.5">
            {t("item_form.section.pricing")}
          </h2>

          {hasVariants ? (
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">{t("item_form.variants.pricing_note")}</p>
          ) : null}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {!hasVariants && (<>
            <label className={labelCls}>
              <span className="flex items-center gap-1">
                {t("item_form.price")}
                <span className="text-red-500 font-bold">*</span>
              </span>
              <input
                data-testid="item-price"
                className={inputCls}
                inputMode="decimal"
                value={price}
                required
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>

            <label className={labelCls}>
              <span className="flex items-center justify-between">
                <span>{t("item_form.mrp")}</span>
                <span className="text-xs text-gray-600 font-normal">{t("item_form.optional")}</span>
              </span>
              <input
                className={inputCls}
                inputMode="decimal"
                value={mrp}
                onChange={(e) => setMrp(e.target.value)}
              />
            </label>
            </>)}

            <label className={labelCls}>
              <span className="flex items-center justify-between">
                <span>{t("item_form.tax_rate")}</span>
                <span className="text-xs text-gray-600 font-normal">{t("item_form.optional")}</span>
              </span>
              <input
                className={inputCls}
                inputMode="decimal"
                value={taxPercent}
                onChange={(e) => setTaxPercent(e.target.value)}
              />
            </label>

            <label className={labelCls}>
              <span className="flex items-center justify-between">
                <span>{t("item_form.cost_price")}</span>
                <span className="text-xs text-gray-600 font-normal">{t("item_form.optional")}</span>
              </span>
              <input
                data-testid="item-cost-price"
                className={inputCls}
                inputMode="decimal"
                value={costPrice}
                onChange={(e) => setCostPrice(e.target.value)}
              />
            </label>

            <label className={`${labelCls} md:col-span-2`}>
              <span className="flex items-center justify-between">
                <span>{t("item_form.hsn_code")}</span>
                <span className="text-xs text-gray-600 font-normal">{t("item_form.optional")}</span>
              </span>
              <input
                data-testid="item-hsn"
                className={inputCls}
                placeholder={t("item_form.hsn_hint")}
                value={hsnCode}
                onChange={(e) => setHsnCode(e.target.value)}
              />
            </label>
          </div>
        </section>

        <VariantEditor
          rows={variantRows}
          setRows={setVariantRows}
          canStart={editId === null || variantGroup !== "" || !loadedIsPlain || !loadedPublished}
          plainItem={editId !== null && loadedIsPlain && variantGroup === "" ? { id: editId, stock: plainStock, barcode } : null}
          sellPrice={price}
          sellMrp={mrp}
          sellCost={costPrice}
        />

        {/* Card 3: Stock & status */}
        <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-xs space-y-4">
          <h2 className="text-base font-bold text-gray-900 border-b border-gray-100 pb-2.5">
            {t("item_form.section.stock_status")}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
            {editId === null && !hasVariants ? (
              <label className={labelCls}>
                <span className="flex items-center justify-between">
                  <span>{t("item_form.opening_stock")}</span>
                  <span className="text-xs text-gray-600 font-normal">{t("item_form.optional")}</span>
                </span>
                <input
                  data-testid="item-opening-stock"
                  className={inputCls}
                  inputMode="decimal"
                  value={openingStock}
                  onChange={(e) => setOpeningStock(e.target.value)}
                />
                <span className="text-xs text-gray-600 mt-1 block">{t("item_form.opening_stock_hint")}</span>
              </label>
            ) : null}

            <div className="flex flex-col justify-center pt-2">
              <label className="flex items-center gap-2.5 text-sm font-semibold text-gray-800 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                />
                <span>{t("item_form.is_active")}</span>
              </label>
            </div>
          </div>
        </section>

        {/* Card 4: Product Photos */}
        <section
          data-testid="item-photo"
          className="rounded-xl border border-gray-200 bg-white p-6 shadow-xs space-y-4"
        >
          <div className="flex items-center justify-between border-b border-gray-100 pb-2.5">
            <div>
              <h2 className="text-base font-bold text-gray-900">
                {t("item_form.section.photos")}
              </h2>
              <p className="text-xs text-gray-600 mt-0.5">
                {t("item_form.photo_hint")}
              </p>
            </div>
            <span className="text-xs font-semibold text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full">
              {photos.length} {photos.length === 1 ? "photo" : "photos"}
            </span>
          </div>

          {/* Photo gallery thumbnails */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4" data-testid="item-photos-grid">
            {photos.map((photo, i) => (
              <div
                key={photo.id}
                data-testid={`item-photo-card-${i}`}
                className={`group relative aspect-square rounded-xl overflow-hidden border-2 bg-gray-50 shadow-xs transition-all ${
                  photo.isMain ? "border-blue-600 ring-2 ring-blue-500/20" : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <img src={photo.url} alt="" className="h-full w-full object-cover" />

                {/* Top Overlay: Main Badge or Set as Main */}
                <div className="absolute top-2 left-2 flex items-center gap-1">
                  {photo.isMain ? (
                    <span
                      data-testid="item-photo-main-badge"
                      className="rounded bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white shadow-xs flex items-center gap-1"
                    >
                      {t("item_form.photo_main_badge")}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void setAsMain(photo)}
                      className="rounded bg-white/95 backdrop-blur-xs px-2 py-0.5 text-xs font-medium text-gray-700 opacity-90 hover:opacity-100 hover:bg-white shadow-xs border border-gray-200 transition-opacity"
                    >
                      {t("item_form.photo_set_main")}
                    </button>
                  )}
                </div>

                {/* Top Right: Remove Button */}
                <button
                  type="button"
                  data-testid={i === 0 ? "item-photo-remove" : `item-photo-remove-${i}`}
                  onClick={() => void removePhoto(photo)}
                  className="absolute top-2 right-2 rounded-full bg-red-600/90 hover:bg-red-700 text-white p-1 shadow-xs transition-opacity"
                  title={t("item_form.photo_remove")}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>

                {/* Bottom: Sync Status Indicator */}
                <div className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between pointer-events-none">
                  {photo.imageUploadedAt ? (
                    <span className="rounded bg-black/60 backdrop-blur-xs px-1.5 py-0.5 text-[10px] font-medium text-green-300">
                      ✓ {t("item_form.photo_uploaded")}
                    </span>
                  ) : (
                    <span className="rounded bg-black/60 backdrop-blur-xs px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                      {t("item_form.photo_pending_sync")}
                    </span>
                  )}
                </div>
              </div>
            ))}

            {/* Add Photo Button Card */}
            <label className="flex flex-col items-center justify-center aspect-square rounded-xl border-2 border-dashed border-gray-300 bg-gray-50/70 hover:bg-gray-100 hover:border-blue-400 cursor-pointer transition-colors p-3 text-center group">
              <div className="rounded-full bg-white p-2 shadow-2xs group-hover:scale-105 transition-transform">
                <svg className="h-6 w-6 text-gray-500 group-hover:text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </div>
              <span className="mt-2 text-xs font-medium text-gray-700 group-hover:text-blue-600">
                {photos.length > 0 ? t("item_form.photo_add_more") : t("item_form.photo_choose")}
              </span>
              <input
                type="file"
                multiple
                accept={Object.values(IMAGE_MIME).join(",")}
                className="hidden"
                data-testid="item-photo-input"
                onChange={(e) => void onPhotoFiles(e)}
              />
            </label>
          </div>
        </section>

        {/* Card 5: Custom Attributes / Specifications */}
        <section
          className="rounded-xl border border-gray-200 bg-white p-6 shadow-xs space-y-4"
          data-testid="item-custom-attributes"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-gray-100 pb-2.5 gap-2">
            <div>
              <h2 className="text-base font-bold text-gray-900">
                {t("item_form.section.custom_attributes")}
              </h2>
              <p className="text-xs text-gray-600 mt-0.5">
                {t("item_form.custom_attributes_hint")}
              </p>
            </div>
            <button
              type="button"
              data-testid="attr-add"
              onClick={() => setCustomAttributes([...customAttributes, { key: "", value: "" }])}
              className="self-start sm:self-auto rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 transition-colors"
            >
              {t("item_form.add_attribute")}
            </button>
          </div>

          {/* Quick Presets */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-gray-500 font-medium">{t("item_form.attribute_presets")}</span>
            {["Size", "Color", "Material", "Flavor", "Weight", "Volume", "Warranty"].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => {
                  if (!customAttributes.some((a) => a.key.toLowerCase() === preset.toLowerCase())) {
                    setCustomAttributes([...customAttributes, { key: preset, value: "" }]);
                  }
                }}
                className="rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1 text-gray-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors cursor-pointer"
              >
                + {preset}
              </button>
            ))}
          </div>

          {customAttributes.length === 0 ? (
            <p className="text-xs text-gray-500 py-2 italic">{t("item_form.no_attributes")}</p>
          ) : (
            <div className="space-y-2.5">
              {customAttributes.map((attr, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder={t("item_form.attribute_name")}
                    data-testid={`attr-key-${idx}`}
                    value={attr.key}
                    onChange={(e) => {
                      const updated = [...customAttributes];
                      updated[idx] = { ...updated[idx]!, key: e.target.value };
                      setCustomAttributes(updated);
                    }}
                    className="w-1/3 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder={t("item_form.attribute_value")}
                    data-testid={`attr-val-${idx}`}
                    value={attr.value}
                    onChange={(e) => {
                      const updated = [...customAttributes];
                      updated[idx] = { ...updated[idx]!, value: e.target.value };
                      setCustomAttributes(updated);
                    }}
                    className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    data-testid={`attr-remove-${idx}`}
                    onClick={() => {
                      setCustomAttributes(customAttributes.filter((_, i) => i !== idx));
                    }}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                    title="Remove attribute"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Secondary Barcodes & Pack Multipliers */}
        {editId !== null && (
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-xs" data-testid="item-secondary-barcodes">
            <h2 className="mb-2 font-bold text-gray-900">Secondary Barcodes & Pack Multipliers</h2>
            <p className="mb-3 text-xs text-gray-600">
              Link multiple barcodes (e.g. inner cartons, outer cases, or alternate supplier barcodes) to this item.
            </p>

            <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-4">
              <input
                type="text"
                placeholder="Barcode"
                className="rounded border border-gray-300 px-3 py-1.5 text-xs font-mono"
                data-testid="secondary-barcode-input"
                value={newSecBarcode}
                onChange={(e) => setNewSecBarcode(e.target.value)}
              />
              <input
                type="number"
                step="0.001"
                min="0.001"
                placeholder="Pack Qty (e.g. 6)"
                className="rounded border border-gray-300 px-3 py-1.5 text-xs"
                data-testid="secondary-pack-qty-input"
                value={newSecQty}
                onChange={(e) => setNewSecQty(e.target.value)}
              />
              <input
                type="text"
                placeholder="Label (e.g. 6-Pack Case)"
                className="rounded border border-gray-300 px-3 py-1.5 text-xs"
                data-testid="secondary-label-input"
                value={newSecLabel}
                onChange={(e) => setNewSecLabel(e.target.value)}
              />
              <button
                type="button"
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                data-testid="secondary-barcode-add"
                onClick={() => void addSecondaryBarcode()}
              >
                + Add Barcode
              </button>
            </div>

            {secError && <p className="mb-3 text-xs text-red-600">{secError}</p>}

            {secondaryBarcodes.length === 0 ? (
              <p className="text-xs text-gray-600">No secondary barcodes registered.</p>
            ) : (
              <div className="divide-y divide-gray-100 rounded border border-gray-100">
                {secondaryBarcodes.map((b) => (
                  <div key={b.id} className="flex items-center justify-between p-2 text-xs">
                    <div>
                      <span className="font-mono font-medium text-gray-800">{b.barcode}</span>
                      <span className="ml-2 text-gray-600">
                        ({formatQty(b.packQtyMilli)} units{b.label ? ` · ${b.label}` : ""})
                      </span>
                    </div>
                    <button
                      type="button"
                      className="text-red-600 hover:underline"
                      data-testid={`secondary-barcode-delete-${b.id}`}
                      onClick={() => void removeSecondaryBarcode(b.id)}
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {error ? (
          <div className="rounded-lg bg-red-50 p-4 border border-red-200 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {/* Real Sticky Footer: same width, border-top, matches card, no overlapping */}
        <div className="sticky bottom-0 z-20 rounded-xl border border-gray-200 bg-white/95 px-6 py-4 backdrop-blur-xs flex items-center justify-end gap-3 shadow-sm">
          <button
            type="button"
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors shadow-2xs"
            onClick={() => navigate("/items")}
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            data-testid="item-save"
            disabled={busy}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-xs"
          >
            {t("common.save")}
          </button>
        </div>
      </form>
    </div>
  );
}

export function formatQtyForInput(milli: number): string {
  return formatQty(milli);
}
