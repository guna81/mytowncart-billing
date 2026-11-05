// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";

import { t } from "../i18n";
import {
  DIAGNOSTICS_KEY,
  diagnosticsEnabled,
  diagnosticsReport,
  recordedEvents,
  setDiagnosticsEnabled,
} from "../lib/diagnostics";
import { getRepository } from "../lib/repository";
import { isInTauri } from "../lib/tauri";

/** B4: opt-in pilot diagnostics. Off by default; nothing leaves the machine. */
export function DiagnosticsPanel() {
  // Not `useState(diagnosticsEnabled)`: a bare function would be treated as a
  // lazy initializer and the checkbox would never reflect the toggle.
  const [enabled, setEnabled] = useState(() => diagnosticsEnabled());
  const [report, setReport] = useState<string | null>(null);

  const toggle = async (on: boolean) => {
    setDiagnosticsEnabled(on);
    setEnabled(on);
    await getRepository().setAppSetting(DIAGNOSTICS_KEY, on ? "1" : null);
    if (!on) setReport(null);
  };

  const show = () => {
    const text = diagnosticsReport(isInTauri());
    setReport(text);
    void navigator.clipboard.writeText(text).catch(() => undefined);
  };

  return (
    <section className="rounded border border-gray-200 bg-white p-4 text-sm text-gray-700" data-testid="diagnostics-panel">
      <h2 className="font-semibold mb-2 text-gray-800">{t("pilot.title")}</h2>
      <p>{t("pilot.intro")}</p>
      <label className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          data-testid="pilot-toggle"
          onChange={(e) => void toggle(e.target.checked)}
        />
        {t("pilot.enable")}
      </label>
      {enabled ? (
        <div className="mt-2">
          <p className="text-gray-500" data-testid="pilot-count">
            {t("pilot.count", { count: recordedEvents().length })}
          </p>
          <button
            type="button"
            className="mt-1 rounded border border-gray-300 bg-white px-3 py-1.5"
            data-testid="pilot-report"
            onClick={show}
          >
            {t("pilot.report")}
          </button>
          {report ? (
            <pre
              className="mt-2 max-h-48 overflow-auto rounded bg-gray-50 p-2 text-xs"
              data-testid="pilot-report-text"
            >
              {report}
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
