// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { seedDemoData } from "@mytowncart-billing/storage";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

export function DemoDataPanel() {
  const [loading, setLoading] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const setProfile = useAppStore((s) => s.setProfile);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);

  const handleSeed = async () => {
    if (!window.confirm(t("settings.demo_data_confirm"))) {
      return;
    }
    setLoading(true);
    setResultMsg(null);
    setErrorMsg(null);
    try {
      const repo = getRepository();
      const summary = await seedDemoData(repo);
      const updatedProfile = await repo.getShopProfile();
      setProfile(updatedProfile);
      bumpDataVersion();
      setResultMsg(
        `${t("settings.demo_data_loaded")} (${summary.itemsCount} items, ${summary.categoriesCount} categories, ${summary.billsCount} bills, ${summary.customersCount} customers)`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-5 shadow-xs text-sm text-gray-700"
      data-testid="demo-data-panel"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="font-semibold text-gray-900 text-base mb-1">
            {t("settings.demo_data_title")}
          </h2>
          <p className="text-gray-600 text-xs sm:text-sm max-w-xl">
            {t("settings.demo_data_desc")}
          </p>
        </div>

        <button
          type="button"
          disabled={loading}
          onClick={() => void handleSeed()}
          data-testid="seed-demo-data-btn"
          className="shrink-0 self-start sm:self-center rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-4 py-2 text-xs sm:text-sm shadow-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
        >
          {loading ? (
            <>
              <span className="h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span>{t("settings.demo_data_loading")}</span>
            </>
          ) : (
            <span>{t("settings.demo_data_load_btn")}</span>
          )}
        </button>
      </div>

      {resultMsg ? (
        <div className="mt-3 p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-xs font-medium flex items-center gap-2">
          <span>✓</span>
          <span>{resultMsg}</span>
        </div>
      ) : null}

      {errorMsg ? (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-xs font-medium">
          {errorMsg}
        </div>
      ) : null}
    </section>
  );
}
