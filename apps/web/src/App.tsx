// SPDX-License-Identifier: Apache-2.0
import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { PrintView } from "./print/PrintView";
import { t } from "./i18n";
import { DIAGNOSTICS_KEY, setDiagnosticsEnabled } from "./lib/diagnostics";
import { getRepository } from "./lib/repository";
import { BillDetailScreen } from "./screens/BillDetailScreen";
import { BillsScreen } from "./screens/BillsScreen";
import { CustomersScreen } from "./screens/CustomersScreen";
import { ItemFormScreen } from "./screens/ItemFormScreen";
import { ItemsScreen } from "./screens/ItemsScreen";
import { MyTownCartScreen } from "./screens/MyTownCartScreen";
import { PosScreen } from "./screens/PosScreen";
import { ReportsScreen } from "./screens/ReportsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SetupWizard } from "./screens/SetupWizard";
import { StockScreen } from "./screens/StockScreen";
import { useAppStore } from "./store/appStore";

export function App() {
  const booted = useAppStore((s) => s.booted);
  const profile = useAppStore((s) => s.profile);
  const setProfile = useAppStore((s) => s.setProfile);
  const setBooted = useAppStore((s) => s.setBooted);

  useEffect(() => {
    void (async () => {
      const repo = getRepository();
      const [p, diag] = await Promise.all([repo.getShopProfile(), repo.getAppSetting(DIAGNOSTICS_KEY)]);
      setProfile(p);
      // Pilot diagnostics stay off unless the seller opted in (B4).
      setDiagnosticsEnabled(diag === "1");
      setBooted(true);
    })();
  }, [setProfile, setBooted]);

  if (!booted) {
    return <main className="p-8 text-gray-600">{t("common.loading")}</main>;
  }

  // First run: no shop profile yet → setup wizard only.
  if (!profile) {
    return (
      <HashRouter>
        <Routes>
          <Route path="/setup" element={<SetupWizard />} />
          <Route path="*" element={<Navigate to="/setup" replace />} />
        </Routes>
      </HashRouter>
    );
  }

  return (
    <HashRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<PosScreen />} />
          <Route path="/items" element={<ItemsScreen />} />
          <Route path="/items/new" element={<ItemFormScreen />} />
          <Route path="/items/:id/edit" element={<ItemFormScreen />} />
          <Route path="/bills" element={<BillsScreen />} />
          <Route path="/bills/:id" element={<BillDetailScreen />} />
          <Route path="/customers" element={<CustomersScreen />} />
          <Route path="/stock" element={<StockScreen />} />
          <Route path="/reports" element={<ReportsScreen />} />
          <Route path="/mytowncart" element={<MyTownCartScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
      <PrintView />
    </HashRouter>
  );
}
