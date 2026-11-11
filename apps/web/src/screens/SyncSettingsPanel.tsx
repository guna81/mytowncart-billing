// SPDX-License-Identifier: Apache-2.0
/**
 * Settings tab: how and when this app syncs with MyTownCart. Pure settings —
 * the schedule itself runs in lib/autoSync.ts (the only background timer).
 */
import { t } from "../i18n";
import {
  SYNC_INTERVAL_CHOICES,
  setAutoSyncSetting,
  setSyncIntervalSetting,
  setSyncScopeSetting,
} from "../lib/autoSync";
import { syncAvailable } from "../lib/syncEngine";
import { useAppStore } from "../store/appStore";

export function SyncSettingsPanel() {
  const auto = useAppStore((s) => s.autoSyncEnabled);
  const intervalMin = useAppStore((s) => s.syncIntervalMin);
  const details = useAppStore((s) => s.syncDetails);
  const list = useAppStore((s) => s.syncList);

  return (
    <div className="space-y-4" data-testid="sync-settings">
      <section className="rounded border border-gray-200 bg-white p-4">
        <h2 className="font-semibold">{t("syncset.title")}</h2>
        {!syncAvailable() ? (
          <p className="mt-2 text-sm text-gray-500">{t("sync.desktop_only")}</p>
        ) : null}

        <fieldset className="mt-4">
          <legend className="text-sm font-semibold text-gray-900">{t("settings.mode")}</legend>
          {(
            [
              [true, "settings.mode_auto", "settings.mode_auto_hint"],
              [false, "settings.mode_manual", "settings.mode_manual_hint"],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={label} className="mt-2 flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="sync-mode"
                className="mt-1"
                checked={auto === value}
                data-testid={value ? "sync-mode-auto" : "sync-mode-manual"}
                onChange={() => void setAutoSyncSetting(value)}
              />
              <span>
                <span className="text-sm font-medium text-gray-900">{t(label)}</span>
                <span className="block text-xs text-gray-600">{t(hint)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="mt-5">
          <label className="block text-sm font-semibold text-gray-900" htmlFor="sync-interval">
            {t("settings.interval")}
          </label>
          <select
            id="sync-interval"
            className="mt-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm disabled:bg-gray-100 disabled:text-gray-400"
            data-testid="sync-interval"
            disabled={!auto}
            value={intervalMin}
            onChange={(e) => void setSyncIntervalSetting(Number(e.target.value))}
          >
            {SYNC_INTERVAL_CHOICES.map((m) => (
              <option key={m} value={m}>
                {t("settings.interval_min", { count: m })}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-600">
            {auto ? t("settings.interval_hint") : t("settings.interval_manual_hint")}
          </p>
        </div>

        <div className="mt-5">
          <p className="text-sm font-semibold text-gray-900">{t("settings.what")}</p>
          {(
            [
              ["details", details, "settings.what_details", "settings.what_details_hint"],
              ["list", list, "settings.what_list", "settings.what_list_hint"],
            ] as const
          ).map(([which, checked, label, hint]) => (
            <label key={which} className="mt-2 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={checked}
                data-testid={`sync-what-${which}`}
                onChange={(e) => void setSyncScopeSetting(which, e.target.checked)}
              />
              <span>
                <span className="text-sm text-gray-900">{t(label)}</span>
                <span className="block text-xs text-gray-600">{t(hint)}</span>
              </span>
            </label>
          ))}
        </div>

      </section>
    </div>
  );
}
