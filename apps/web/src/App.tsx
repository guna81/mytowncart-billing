// SPDX-License-Identifier: Apache-2.0
import { OwnerOnly } from "./components/OwnerOnly";
import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PrintView } from "./print/PrintView";
import { t } from "./i18n";
import { checkAndRunAutoBackup } from "./lib/autoBackup";
import { useAutoSync } from "./lib/autoSync";
import { DIAGNOSTICS_KEY, setDiagnosticsEnabled } from "./lib/diagnostics";
import { SHOP_LOGO_KEY } from "./lib/shopLogo";
import { getRepository } from "./lib/repository";
import { BillDetailScreen } from "./screens/BillDetailScreen";
import { BillsScreen } from "./screens/BillsScreen";
import { CustomersScreen } from "./screens/CustomersScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { ItemFormScreen } from "./screens/ItemFormScreen";
import { ItemsScreen } from "./screens/ItemsScreen";
import { CategoriesScreen } from "./screens/CategoriesScreen";
import { BarcodeLabelsScreen } from "./screens/BarcodeLabelsScreen";
import { MyTownCartScreen } from "./screens/MyTownCartScreen";
import { PosScreen } from "./screens/PosScreen";
import { ReportsScreen } from "./screens/ReportsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SetupWizard } from "./screens/SetupWizard";
import { RestoreBackupScreen } from "./screens/RestoreBackupScreen";
import { StockScreen } from "./screens/StockScreen";
import { StockAuditScreen } from "./screens/StockAuditScreen";
import { SuppliersScreen } from "./screens/SuppliersScreen";
import { PurchasesScreen } from "./screens/PurchasesScreen";
import { PurchaseFormScreen } from "./screens/PurchaseFormScreen";
import { DayEndScreen } from "./screens/DayEndScreen";
import { UsersScreen } from "./screens/UsersScreen";
import { useAppStore } from "./store/appStore";

export function App() {
  const booted = useAppStore((s) => s.booted);
  const profile = useAppStore((s) => s.profile);
  const locale = useAppStore((s) => s.locale);
  const setProfile = useAppStore((s) => s.setProfile);
  const setShopLogo = useAppStore((s) => s.setShopLogo);
  const setBooted = useAppStore((s) => s.setBooted);
  const runUpdateCheck = useAppStore((s) => s.runUpdateCheck);

  useAutoSync();

  useEffect(() => {
    void (async () => {
      const repo = getRepository();
      const [p, diag, logo] = await Promise.all([
        repo.getShopProfile(),
        repo.getAppSetting(DIAGNOSTICS_KEY),
        repo.getAppSetting(SHOP_LOGO_KEY),
      ]);
      setProfile(p);
      setShopLogo(logo);
      // Pilot diagnostics stay off unless the seller opted in (B4).
      setDiagnosticsEnabled(diag === "1");
      setBooted(true);
      void checkAndRunAutoBackup();
      void runUpdateCheck();
    })();
  }, [setProfile, setShopLogo, setBooted, runUpdateCheck]);

  if (!booted) {
    return <main className="p-8 text-gray-600">{t("common.loading")}</main>;
  }

  // First run: no shop profile yet → setup wizard only.
  if (!profile) {
    return (
      <HashRouter>
        <Routes>
          <Route path="/setup" element={<SetupWizard />} />
          <Route path="/restore" element={<RestoreBackupScreen />} />
          <Route path="*" element={<Navigate to="/setup" replace />} />
        </Routes>
      </HashRouter>
    );
  }

  return (
    <HashRouter key={locale}>
      <Layout>
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<PosScreen />} />
            <Route path="/dashboard" element={<OwnerOnly><DashboardScreen /></OwnerOnly>} />
            <Route path="/items" element={<ItemsScreen />} />
            <Route path="/items/labels" element={<BarcodeLabelsScreen />} />
            <Route path="/categories" element={<OwnerOnly><CategoriesScreen /></OwnerOnly>} />
            <Route path="/items/new" element={<OwnerOnly><ItemFormScreen /></OwnerOnly>} />
            <Route path="/items/:id/edit" element={<OwnerOnly><ItemFormScreen /></OwnerOnly>} />
            <Route path="/bills" element={<BillsScreen />} />
            <Route path="/bills/:id" element={<BillDetailScreen />} />
            <Route path="/customers" element={<CustomersScreen />} />
            <Route path="/suppliers" element={<OwnerOnly><SuppliersScreen /></OwnerOnly>} />
            <Route path="/purchases" element={<OwnerOnly><PurchasesScreen /></OwnerOnly>} />
            <Route path="/purchases/new" element={<OwnerOnly><PurchaseFormScreen /></OwnerOnly>} />
            <Route path="/stock" element={<StockScreen />} />
            <Route path="/stock-audit" element={<OwnerOnly><StockAuditScreen /></OwnerOnly>} />
            <Route path="/day-end" element={<DayEndScreen />} />
            <Route path="/users" element={<OwnerOnly><UsersScreen /></OwnerOnly>} />
            <Route path="/reports" element={<OwnerOnly><ReportsScreen /></OwnerOnly>} />
            <Route path="/mytowncart" element={<OwnerOnly><MyTownCartScreen /></OwnerOnly>} />
            <Route path="/settings" element={<OwnerOnly><SettingsScreen /></OwnerOnly>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </Layout>
      <PrintView />
    </HashRouter>
  );
}
