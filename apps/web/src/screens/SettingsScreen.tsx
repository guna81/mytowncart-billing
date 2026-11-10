// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type FormEvent } from "react";

import { APP_VERSION, formatQty, parseQty } from "@mytowncart-billing/core";
import type { ShopProfile } from "@mytowncart-billing/storage";
import { BackupPanel } from "../components/BackupPanel";
import { DemoDataPanel } from "../components/DemoDataPanel";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel";
import { LanServerPanel } from "../components/LanServerPanel";
import { UpdateAvailableButton } from "../components/UpdateAvailableButton";
import { PageHeader } from "../components/ui";
import { setLocale as setI18nLocale, t, type SupportedLocale } from "../i18n";
import { getRepository } from "../lib/repository";
import { processLogoFile, SHOP_LOGO_KEY } from "../lib/shopLogo";
import { useAppStore } from "../store/appStore";

const inputCls = "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 shadow-2xs";
const labelCls = "block text-sm font-medium text-gray-700";

export function SettingsScreen() {
  const profile = useAppStore((s) => s.profile);
  const setProfile = useAppStore((s) => s.setProfile);
  const shopLogo = useAppStore((s) => s.shopLogo);
  const setShopLogo = useAppStore((s) => s.setShopLogo);
  const locale = useAppStore((s) => s.locale);
  const setAppLocale = useAppStore((s) => s.setAppLocale);
  const updateInfo = useAppStore((s) => s.updateInfo);
  const updateChecking = useAppStore((s) => s.updateChecking);
  const updateCheckResult = useAppStore((s) => s.updateCheckResult);
  const runUpdateCheck = useAppStore((s) => s.runUpdateCheck);

  const handleLanguageChange = (next: SupportedLocale) => {
    setI18nLocale(next);
    setAppLocale(next);
  };

  const [form, setForm] = useState<Partial<ShopProfile>>({});
  const [logo, setLogo] = useState<string | null>(null);
  const [lowStock, setLowStock] = useState("0");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    setForm(profile);
    setLowStock(formatQty(profile.lowStockThresholdMilli));
    setLogo(shopLogo);
  }, [profile, shopLogo]);

  const set = <K extends keyof ShopProfile>(key: K, value: ShopProfile[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onLogoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const result = await processLogoFile(file);
    if (!result.ok) {
      if (result.error === "too_large") {
        setError(t("settings.logo_too_large"));
      } else if (result.error === "invalid_type") {
        setError(t("settings.logo_invalid_type"));
      } else {
        setError(t("common.error", { message: "Failed to read image" }));
      }
      return;
    }
    setLogo(result.dataUrl ?? null);
    e.target.value = "";
  };

  const onRemoveLogo = () => {
    setLogo(null);
  };

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
    await getRepository().setAppSetting(SHOP_LOGO_KEY, logo);
    setProfile(await getRepository().getShopProfile());
    setShopLogo(logo);
    setSaved(true);
  };

  if (!profile) return null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader title={t("settings.title")} />

      <form onSubmit={(e) => void onSubmit(e)} className="space-y-6">
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-xs">
          <h2 className="font-semibold mb-3">{t("settings.shop")}</h2>

          {/* Shop Logo Provision */}
          <div className="mb-5 pb-5 border-b border-gray-100 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="relative flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 overflow-hidden">
              {logo ? (
                <img
                  src={logo}
                  alt={form.name || "Shop Logo"}
                  className="h-full w-full object-contain p-1"
                  data-testid="settings-logo-preview"
                />
              ) : (
                <div
                  className="flex flex-col items-center justify-center text-gray-500 p-2 text-center"
                  data-testid="settings-logo-placeholder"
                >
                  <svg className="h-6 w-6 text-gray-500 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <span className="text-[10px] font-bold tracking-wider uppercase text-gray-600">MTC</span>
                </div>
              )}
            </div>
            <div className="flex-1 space-y-1">
              <span className="block text-sm font-medium text-gray-800">{t("settings.shop_logo")}</span>
              <p className="text-xs text-gray-600">{t("settings.shop_logo_hint")}</p>
              <div className="flex flex-wrap items-center gap-2 pt-1.5">
                <label className="cursor-pointer inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-xs hover:bg-gray-50 hover:text-gray-900 transition-colors">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    className="sr-only"
                    data-testid="settings-logo-input"
                    onChange={(e) => void onLogoFileChange(e)}
                  />
                  <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  {logo ? t("settings.change_logo") : t("settings.upload_logo")}
                </label>
                {logo ? (
                  <button
                    type="button"
                    onClick={onRemoveLogo}
                    data-testid="settings-logo-remove"
                    className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 transition-colors"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    {t("settings.remove_logo")}
                  </button>
                ) : null}
              </div>
            </div>
          </div>

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
        <LanServerPanel />
        <DiagnosticsPanel />
        <DemoDataPanel />

        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-xs text-sm text-gray-600">
          <h2 className="font-semibold mb-2 text-gray-800">{t("settings.printer")}</h2>
          <p>{t("settings.printer_note")}</p>
          <h2 className="font-semibold mt-4 mb-2 text-gray-800">{t("settings.updates")}</h2>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-gray-500 font-mono">v{APP_VERSION}</span>
              <button
                type="button"
                data-testid="check-updates-btn"
                disabled={updateChecking}
                onClick={() => void runUpdateCheck(true)}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-xs hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                {updateChecking ? t("update.checking") : t("update.check")}
              </button>
            </div>

            {updateChecking ? (
              <p className="text-xs text-gray-500 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
                {t("update.checking")}
              </p>
            ) : updateInfo ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-amber-700">
                  {t("update.available", { version: updateInfo.tag })}
                </span>
                <UpdateAvailableButton />
              </div>
            ) : updateCheckResult?.failed ? (
              <p className="text-xs text-amber-700">
                {t("update.check_failed")}
              </p>
            ) : updateCheckResult ? (
              <p className="text-xs text-green-700 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                {t("update.up_to_date", { version: `v${APP_VERSION}` })}
              </p>
            ) : null}

            <p className="text-xs text-gray-500">
              {t("update.backup_first")}
            </p>
          </div>
          <h2 className="font-semibold mt-4 mb-2 text-gray-800">{t("settings.language")}</h2>
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              type="button"
              data-testid="lang-en"
              onClick={() => handleLanguageChange("en")}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors ${
                locale === "en"
                  ? "bg-blue-50 border-blue-500 text-blue-700 shadow-xs"
                  : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"
              }`}
            >
              English
            </button>
            <button
              type="button"
              data-testid="lang-hi"
              onClick={() => handleLanguageChange("hi")}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors ${
                locale === "hi"
                  ? "bg-blue-50 border-blue-500 text-blue-700 shadow-xs"
                  : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"
              }`}
            >
              हिन्दी (Hindi)
            </button>
            <button
              type="button"
              data-testid="lang-ta"
              onClick={() => handleLanguageChange("ta")}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors ${
                locale === "ta"
                  ? "bg-blue-50 border-blue-500 text-blue-700 shadow-xs"
                  : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"
              }`}
            >
              தமிழ் (Tamil)
            </button>
          </div>
        </section>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {saved ? (
          <p className="text-sm text-green-700" data-testid="settings-saved">
            {t("settings.saved")}
          </p>
        ) : null}
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            data-testid="settings-save"
            className="rounded bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-blue-700"
          >
            {t("common.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
