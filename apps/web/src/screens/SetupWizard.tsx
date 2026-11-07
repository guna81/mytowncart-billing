// SPDX-License-Identifier: Apache-2.0
import { useState, type FormEvent } from "react";

import { t } from "../i18n";
import { getRepository, isInTauri } from "../lib/repository";
import { processLogoFile, SHOP_LOGO_KEY } from "../lib/shopLogo";
import { lanServerStart } from "../lib/tauri";
import { useAppStore } from "../store/appStore";

/** First-run wizard (roadmap §8.8): shop name, GST yes/no, invoice prefix. */
export function SetupWizard() {
  const setProfile = useAppStore((s) => s.setProfile);
  const setShopLogo = useAppStore((s) => s.setShopLogo);
  const [name, setName] = useState("");
  const [logo, setLogo] = useState<string | null>(null);
  const [gst, setGst] = useState(false);
  const [includeTax, setIncludeTax] = useState(true);
  const [prefix, setPrefix] = useState("INV-");
  const [enableLan, setEnableLan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
        setError(t("common.error", { message: "Could not read logo image" }));
      }
      return;
    }
    setLogo(result.dataUrl ?? null);
    e.target.value = "";
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === "") {
      setError(t("setup.name_required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const profile = {
        name: name.trim(),
        gstEnabled: gst,
        pricesIncludeTax: gst ? includeTax : false,
        invoicePrefix: prefix.trim() || "INV-",
        address: "",
        phone: "",
        gstin: "",
        receiptFooter: "",
        lowStockThresholdMilli: 5000,
      };
      await getRepository().saveShopProfile(profile);
      if (logo) {
        await getRepository().setAppSetting(SHOP_LOGO_KEY, logo);
        setShopLogo(logo);
      }
      if (enableLan) {
        await getRepository().setAppSetting("lan.autostart", "true");
        await getRepository().setAppSetting("lan.port", "8080");
        if (isInTauri()) {
          try {
            await lanServerStart(8080);
          } catch (e) {
            console.error("Failed to start LAN server on setup", e);
          }
        }
      }
      setProfile({ ...profile, updatedAt: new Date().toISOString() });
    } catch (err) {
      setError(t("common.error", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-100 flex items-start justify-center pt-16">
      <form
        onSubmit={(e) => void submit(e)}
        className="bg-white rounded-lg shadow p-8 w-full max-w-md space-y-5"
      >
        <div>
          <h1 className="text-xl font-bold">{t("setup.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("setup.subtitle")}</p>
        </div>

        <label className="block">
          <span className="text-sm font-medium">{t("setup.shop_name")}</span>
          <input
            data-testid="setup-shop-name"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={name}
            placeholder={t("setup.shop_name_ph")}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>

        <div>
          <span className="text-sm font-medium text-gray-700">{t("setup.shop_logo")}</span>
          <div className="mt-1.5 flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 overflow-hidden">
              {logo ? (
                <img src={logo} alt="Logo" className="h-full w-full object-contain p-0.5" data-testid="setup-logo-preview" />
              ) : (
                <span className="text-xs font-bold text-gray-600">MTC</span>
              )}
            </div>
            <label className="cursor-pointer rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shadow-xs">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="sr-only"
                data-testid="setup-logo-input"
                onChange={(e) => void onLogoChange(e)}
              />
              {logo ? t("settings.change_logo") : t("settings.upload_logo")}
            </label>
            {logo ? (
              <button
                type="button"
                onClick={() => setLogo(null)}
                data-testid="setup-logo-remove"
                className="text-xs text-red-600 hover:underline"
              >
                {t("settings.remove_logo")}
              </button>
            ) : null}
          </div>
        </div>

        <div>
          <span className="text-sm font-medium">{t("setup.gst")}</span>
          <div className="mt-1 flex gap-4">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="gst"
                data-testid="setup-gst-yes"
                checked={gst}
                onChange={() => setGst(true)}
              />
              {t("common.yes")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="gst"
                data-testid="setup-gst-no"
                checked={!gst}
                onChange={() => setGst(false)}
              />
              {t("common.no")}
            </label>
          </div>
          <p className="text-xs text-gray-600 mt-1">{t("setup.gst_hint")}</p>
          {gst ? (
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="setup-include-tax"
                checked={includeTax}
                onChange={(e) => setIncludeTax(e.target.checked)}
              />
              {t("setup.prices_include_tax")}
            </label>
          ) : null}
        </div>

        <label className="block">
          <span className="text-sm font-medium">{t("setup.prefix")}</span>
          <input
            data-testid="setup-prefix"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          />
          <span className="text-xs text-gray-600">{t("setup.prefix_hint")}</span>
        </label>

        <div className="rounded border border-gray-200 bg-gray-50/50 p-3">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              data-testid="setup-enable-lan"
              checked={enableLan}
              onChange={(e) => setEnableLan(e.target.checked)}
              className="mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <div>
              <span className="text-sm font-medium text-gray-800">
                {t("setup.lan_option")}
              </span>
              <p className="text-xs text-gray-500 mt-0.5">
                {t("setup.lan_option_hint")}
              </p>
            </div>
          </label>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        <button
          type="submit"
          data-testid="setup-start"
          disabled={busy}
          className="w-full rounded bg-blue-600 py-2 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
        >
          {t("setup.start")}
        </button>
      </form>
    </main>
  );
}
