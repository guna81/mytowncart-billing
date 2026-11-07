// SPDX-License-Identifier: Apache-2.0
import { Link } from "react-router-dom";

import { RestoreFlow } from "../components/RestoreFlow";
import { t } from "../i18n";

/** Reached from the setup wizard on a fresh install: bring a whole shop back. */
export function RestoreBackupScreen() {
  return (
    <main className="min-h-screen bg-gray-100 flex items-start justify-center pt-16">
      <div className="bg-white rounded-lg shadow p-8 w-full max-w-md space-y-4 text-sm">
        <div>
          <h1 className="text-xl font-bold">{t("backup.restore_first_title")}</h1>
          <p className="mt-1 text-gray-500">{t("backup.restore_first_subtitle")}</p>
        </div>
        <RestoreFlow />
        <Link to="/setup" className="block text-blue-700 underline" data-testid="restore-back-to-setup">
          {t("backup.restore_back")}
        </Link>
      </div>
    </main>
  );
}
