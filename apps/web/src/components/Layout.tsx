// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { t, type I18nKey } from "../i18n";
import { recordEvent } from "../lib/diagnostics";
import { APP_NAME, APP_VERSION } from "@mytowncart-billing/core";
import { useAppStore } from "../store/appStore";
import { PinLockModal } from "./PinLockModal";
import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";

interface NavItem {
  to: string;
  key: I18nKey;
  icon: (active: boolean) => ReactNode;
}

const NAV: NavItem[] = [
  {
    to: "/dashboard",
    key: "nav.dashboard",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
      </svg>
    ),
  },
  {
    to: "/",
    key: "nav.pos",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
      </svg>
    ),
  },
  {
    to: "/items",
    key: "nav.items",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
      </svg>
    ),
  },
  {
    to: "/bills",
    key: "nav.bills",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    to: "/customers",
    key: "nav.customers",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
      </svg>
    ),
  },
  {
    to: "/suppliers",
    key: "nav.suppliers",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M8 17a5 5 0 01-.916-9.916 5.002 5.002 0 019.832 0A5.002 5.002 0 0116 17m-7-5l3-3m0 0l3 3m-3-3v12" />
      </svg>
    ),
  },
  {
    to: "/purchases",
    key: "nav.purchases",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
      </svg>
    ),
  },
  {
    to: "/stock",
    key: "nav.stock",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
      </svg>
    ),
  },
  {
    to: "/stock-audit",
    key: "nav.stock_audit",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    to: "/day-end",
    key: "nav.day_end",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    to: "/users",
    key: "nav.users",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
      </svg>
    ),
  },
  {
    to: "/reports",
    key: "nav.reports",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    to: "/mytowncart",
    key: "nav.mytowncart",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
      </svg>
    ),
  },
  {
    to: "/settings",
    key: "nav.settings",
    icon: (active) => (
      <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const profile = useAppStore((s) => s.profile);
  const locale = useAppStore((s) => s.locale);
  const isLocked = useAppStore((s) => s.isLocked);
  const setIsLocked = useAppStore((s) => s.setIsLocked);
  const currentUser = useAppStore((s) => s.currentUser);
  const setCurrentUser = useAppStore((s) => s.setCurrentUser);
  const [collapsed, setCollapsed] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if (e.key === "F1" || (!isInput && e.key === "?")) {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    recordEvent("screen", pathname.replace(/\/\d+/g, "/:id"));
  }, [pathname]);

  const isPos = pathname === "/";

  return (
    <div className="app-shell flex h-screen overflow-hidden bg-gray-100 text-gray-800">
      {/* Sidebar Navigation */}
      <aside
        className={`flex flex-col border-r border-gray-200 bg-white transition-all duration-200 select-none ${
          collapsed ? "w-16" : "w-60"
        }`}
        data-testid="app-sidebar"
      >
        {/* Brand Header */}
        <div className="flex h-16 items-center justify-between px-3.5 border-b border-gray-100">
          <NavLink to="/" aria-label={`${APP_NAME} home`} className="flex items-center gap-2 overflow-hidden">
            {collapsed ? (
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white font-bold text-sm shadow">
                MTC
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white font-bold text-xs shadow">
                  MTC
                </div>
                <div className="leading-tight">
                  <p className="font-bold text-sm text-gray-900 tracking-tight">MyTownCart</p>
                  <p className="text-[10px] uppercase font-semibold text-blue-600 tracking-wider">Billing POS</p>
                </div>
              </div>
            )}
          </NavLink>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="p-1 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-blue-50 text-blue-700 font-semibold shadow-xs"
                    : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                }`
              }
              title={collapsed ? t(item.key) : undefined}
            >
              {({ isActive }) => (
                <>
                  <span className="shrink-0">{item.icon(isActive)}</span>
                  {!collapsed ? <span className="truncate">{t(item.key)}</span> : null}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Quick Lock & User Status Bar */}
        <div className="p-3 border-t border-gray-100 bg-gray-50/50">
          {!collapsed ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="overflow-hidden">
                  <p className="text-xs font-semibold text-gray-800 truncate" title={profile?.name}>
                    {profile?.name || "Shop"}
                  </p>
                  <p className="text-[11px] text-gray-500 truncate">
                    {currentUser ? `${currentUser.name} (${currentUser.role})` : "Terminal Ready"}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="sidebar-shortcuts-btn"
                    onClick={() => setShowShortcuts(true)}
                    title="Keyboard Shortcuts (F1 or ?)"
                    className="p-1.5 rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-800 transition-colors text-xs font-mono font-bold"
                  >
                    ⌨?
                  </button>
                  <button
                    type="button"
                    data-testid="sidebar-lock-btn"
                    onClick={() => setIsLocked(true)}
                    title={t("users.quick_lock")}
                    className="p-1.5 rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-800 transition-colors"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between text-[10px] text-gray-400 font-mono">
                <span>v{APP_VERSION}</span>
                <span className="inline-flex items-center gap-1 text-green-600 font-sans font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  Online
                </span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                data-testid="sidebar-lock-btn"
                onClick={() => setIsLocked(true)}
                title={t("users.quick_lock")}
                className="p-1 rounded text-gray-500 hover:bg-gray-200 hover:text-gray-800"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </button>
              <span className="inline-block h-2 w-2 rounded-full bg-green-500" title="Online" />
            </div>
          )}
        </div>
      </aside>

      {/* Main Screen Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden bg-gray-100">
        <div className={`flex-1 overflow-y-auto ${isPos ? "p-4 lg:p-6" : "max-w-6xl w-full mx-auto p-4 lg:p-6"}`}>
          {children}
        </div>
      </main>

      {/* Fullscreen Quick Lock Modal */}
      {isLocked && (
        <PinLockModal
          isOpen={isLocked}
          isQuickLock={true}
          onSuccess={(user) => {
            setCurrentUser(user);
            setIsLocked(false);
          }}
        />
      )}

      {/* Keyboard Shortcuts Cheat Sheet */}
      <KeyboardShortcutsModal
        isOpen={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />
    </div>
  );
}
