// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type FormEvent } from "react";

import { formatQty, parseQty } from "@mytowncart-billing/core";
import type { ShopProfile } from "@mytowncart-billing/storage";
import { BackupPanel } from "../components/BackupPanel";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

const inputCls = "mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm";
const labelCls = "block text-sm font-medium text-gray-700";

export function SettingsScreen() {
  const profile = useAppStore((s) => s.profile);
  const setProfile = useAppStore((s) => s.setProfile);

  const [form, setForm] = useState<Partial<ShopProfile>>({});
  const [lowStock, setLowStock] = useState("0");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    setForm(profile);
    setLowStock(formatQty(profile.lowStockThresholdMilli));
  }, [profile]);

  const set = <K extends keyof ShopProfile>(key: K, value: ShopProfile[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const threshold = parseQty(lowStock);
    if (threshold === null || threshold < 0) {
      setError(t("common.error", { message: "low-stock threshold" }));
      return;
    }
    if (!form.name?.trim()) {
      setError(t("setup.name_required"));
      return;
    }
    await getRepository().saveShopProfile({
      name: form.name.trim(),
      gstEnabled: form.gstEnabled ?? false,
      pricesIncludeTax: form.pricesIncludeTax ?? true,
      invoicePrefix: form.invoicePrefix ?? "INV-",
      address: form.address ?? "",
      phone: form.phone ?? "",
      gstin: form.gstin ?? "",
      receiptFooter: form.receiptFooter ?? "",
      lowStockThresholdMilli: threshold,
    });
    setProfile(await getRepository().getShopProfile());
    setSaved(true);
  };

  if (!profile) return null;

  return (
    <div className="max-w-3xl">
      <h1 className="text-lg font-bold mb-4">{t("settings.title")}</h1>

      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
        <section className="rounded border border-gray-200 bg-white p-4">
          <h2 className="font-semibold mb-3">{t("settings.shop")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelCls}>
              {t("setup.shop_name")}
              <input
                className={inputCls}
                value={form.name ?? ""}
                onChange={(e) => set("name", e.target.value)}
              />
            </label>
            <label className={labelCls}>
              {t("common.phone")}
              <input
                className={inputCls}
                value={form.phone ?? ""}
                onChange={(e) => set("phone", e.target.value)}
              />
            </label>
            <label className={`${labelCls} sm:col-span-2`}>
              {t("settings.address")}
              <textarea
                className={inputCls}
                rows={2}
                value={form.address ?? ""}
                onChange={(e) => set("address", e.target.value)}
              />
            </label>
            <label className={labelCls}>
              {t("settings.invoice_prefix")}
              <input
                className={inputCls}
                value={form.invoicePrefix ?? ""}
                onChange={(e) => set("invoicePrefix", e.target.value)}
              />
            </label>
            <label className={labelCls}>
              {t("settings.low_stock")}
              <input
                className={inputCls}
                value={lowStock}
                onChange={(e) => setLowStock(e.target.value)}
              />
            </label>
            <label className={labelCls}>
              {t("settings.gstin")}
              <input
                className={inputCls}
                value={form.gstin ?? ""}
                onChange={(e) => set("gstin", e.target.value)}
              />
            </label>
            <label className={labelCls}>
              {t("settings.receipt_footer")}
              <input
                className={inputCls}
                value={form.receiptFooter ?? ""}
                onChange={(e) => set("receiptFooter", e.target.value)}
              />
            </label>
          </div>
          <div className="mt-3 space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.gstEnabled ?? false}
                onChange={(e) => set("gstEnabled", e.target.checked)}
              />
              {t("settings.gst_enabled")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.pricesIncludeTax ?? true}
                onChange={(e) => set("pricesIncludeTax", e.target.checked)}
              />
              {t("settings.prices_include_tax")}
            </label>
          </div>
        </section>

        <BackupPanel />
        <DiagnosticsPanel />

        <section className="rounded border border-gray-200 bg-white p-4 text-sm text-gray-600">
          <h2 className="font-semibold mb-2 text-gray-800">{t("settings.printer")}</h2>
          <p>{t("settings.printer_note")}</p>
          <h2 className="font-semibold mt-4 mb-2 text-gray-800">{t("settings.updates")}</h2>
          <p>{t("settings.updates_note")}</p>
          <h2 className="font-semibold mt-4 mb-2 text-gray-800">{t("settings.language")}</h2>
          <p>{t("settings.language_en")}</p>
        </section>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {saved ? (
          <p className="text-sm text-green-700" data-testid="settings-saved">
            {t("settings.saved")}
          </p>
        ) : null}
        <button
          type="submit"
          data-testid="settings-save"
          className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          {t("common.save")}
        </button>
      </form>
    </div>
  );
}
