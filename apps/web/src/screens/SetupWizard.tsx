// SPDX-License-Identifier: Apache-2.0
import { useState, type FormEvent } from "react";

import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

/** First-run wizard (roadmap §8.8): shop name, GST yes/no, invoice prefix. */
export function SetupWizard() {
  const setProfile = useAppStore((s) => s.setProfile);
  const [name, setName] = useState("");
  const [gst, setGst] = useState(false);
  const [includeTax, setIncludeTax] = useState(true);
  const [prefix, setPrefix] = useState("INV-");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        lowStockThresholdMilli: 0,
      };
      await getRepository().saveShopProfile(profile);
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
          <p className="text-xs text-gray-500 mt-1">{t("setup.gst_hint")}</p>
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
          <span className="text-xs text-gray-500">{t("setup.prefix_hint")}</span>
        </label>

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
