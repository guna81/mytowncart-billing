// SPDX-License-Identifier: Apache-2.0
import { useEffect, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { t, type I18nKey } from "../i18n";
import { recordEvent } from "../lib/diagnostics";
import { APP_NAME } from "@mytowncart-billing/core";

const NAV: { to: string; key: I18nKey; disabled?: boolean; titleKey?: I18nKey }[] = [
  { to: "/", key: "nav.pos" },
  { to: "/items", key: "nav.items" },
  { to: "/bills", key: "nav.bills" },
  { to: "/customers", key: "nav.customers" },
  { to: "/stock", key: "nav.stock" },
  { to: "/reports", key: "nav.reports" },
  { to: "/mytowncart", key: "nav.mytowncart" },
  { to: "/settings", key: "nav.settings" },
];

export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  useEffect(() => {
    // Route ids are collapsed so the log never carries a bill or customer id.
    recordEvent("screen", pathname.replace(/\/\d+/g, "/:id"));
  }, [pathname]);

  return (
    <div className="app-shell min-h-screen bg-gray-100 text-gray-800">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-6xl px-4 flex items-center gap-6 h-14">
          <NavLink to="/" aria-label={`${APP_NAME} home`} className="shrink-0">
            <img src="/brand/logo-full.svg" alt={APP_NAME} width={169} height={48} />
          </NavLink>
          <nav className="flex gap-1 overflow-x-auto">
            {NAV.map((item) =>
              item.disabled ? (
                <span
                  key={item.to}
                  title={item.titleKey ? t(item.titleKey) : undefined}
                  className="px-3 py-2 text-sm rounded text-gray-400 cursor-not-allowed select-none"
                  aria-disabled="true"
                  data-testid={`nav-disabled-${item.key}`}
                >
                  {t(item.key)}
                </span>
              ) : (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    `px-3 py-2 text-sm rounded ${
                      isActive ? "bg-blue-50 text-blue-700 font-semibold" : "text-gray-600 hover:bg-gray-50"
                    }`
                  }
                >
                  {t(item.key)}
                </NavLink>
              ),
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
