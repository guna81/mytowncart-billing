// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";

import { t, type I18nKey } from "../i18n";
import { recordEvent } from "../lib/diagnostics";
import { APP_NAME, APP_VERSION } from "@mytowncart-billing/core";
import { useAppStore } from "../store/appStore";
import { PinLockModal } from "./PinLockModal";
import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";
import { UpdateAvailableButton } from "./UpdateAvailableButton";
import { Button, Modal } from "./ui";
import { getRepository } from "../lib/repository";
import { isOwnerOnlyPath, refreshLoginState, useIsOwner } from "../lib/roles";

const SIDEBAR_KEY = "mtc.sidebar";

interface NavItem {
  to: string;
  key: I18nKey;
  icon: (active: boolean) => ReactNode;
}

interface NavGroup {
  labelKey?: I18nKey;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "nav.group.sell",
    items: [
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
    ],
  },
  {
    labelKey: "nav.group.inventory",
    items: [
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
        to: "/categories",
        key: "nav.categories",
        icon: (active) => (
          <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
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
    ],
  },
  {
    labelKey: "nav.group.manage",
    items: [
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
        to: "/day-end",
        key: "nav.day_end",
        icon: (active) => (
          <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
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
        to: "/users",
        key: "nav.users",
        icon: (active) => (
          <svg className={`h-5 w-5 ${active ? "text-blue-600" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.8} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
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
    ],
  },
];

export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const profile = useAppStore((s) => s.profile);
  const shopLogo = useAppStore((s) => s.shopLogo);
  const isLocked = useAppStore((s) => s.isLocked);
  const setIsLocked = useAppStore((s) => s.setIsLocked);
  const currentUser = useAppStore((s) => s.currentUser);
  const setCurrentUser = useAppStore((s) => s.setCurrentUser);
  // First launch: always open. After that, restore whatever the user last chose.
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try {
      const saved = window.localStorage.getItem(SIDEBAR_KEY);
      return saved === "collapsed";
    } catch {
      return false;
    }
  });
  const setCollapsed = (value: boolean) => {
    setCollapsedState(value);
    try {
      window.localStorage.setItem(SIDEBAR_KEY, value ? "collapsed" : "open");
    } catch {
      /* storage unavailable — keep in-memory state only */
    }
  };
  const isOwner = useIsOwner();
  const [showShortcuts, setShowShortcuts] = useState(false);

  // On start-up (and after users change) lock the terminal if a PIN login is needed.
  useEffect(() => {
    void refreshLoginState();
  }, []);
  const [showNoUsersModal, setShowNoUsersModal] = useState(false);

  const handleQuickLockClick = async () => {
    try {
      const users = await getRepository().listUsers();
      const activeUsers = users.filter((u) => u.isActive && u.hasPin);
      if (activeUsers.length === 0) {
        setShowNoUsersModal(true);
        return;
      }
      // Locking ends the login session, so the next person must enter their own PIN.
      setCurrentUser(null);
      await getRepository().logout();
      setIsLocked(true);
    } catch {
      setIsLocked(true);
    }
  };


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
        className={`flex flex-col border-r border-gray-200 bg-white transition-all duration-200 select-none overflow-x-hidden ${
          collapsed ? "w-16" : "w-60"
        }`}
        data-testid="app-sidebar"
      >
        {/* Brand Header */}
        {collapsed ? (
          <div className="flex h-16 w-full flex-col items-center justify-center border-b border-gray-100 shrink-0 px-1">
            <NavLink
              to="/"
              aria-label={`${APP_NAME} home`}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-transform hover:scale-105 focus:outline-none"
              title={profile?.name || APP_NAME}
            >
              {shopLogo ? (
                <img
                  src={shopLogo}
                  alt={profile?.name || APP_NAME}
                  className="h-8 w-8 shrink-0 rounded-lg object-contain border border-gray-200 bg-white p-0.5 shadow-xs"
                  data-testid="sidebar-shop-logo"
                />
              ) : (
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white font-bold text-xs shadow-xs"
                  data-testid="sidebar-default-logo"
                >
                  MTC
                </div>
              )}
            </NavLink>
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="mt-0.5 flex items-center justify-center rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-blue-600 transition-colors"
              title="Expand sidebar"
              aria-label="Expand sidebar"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="flex h-16 items-center justify-between px-3 border-b border-gray-100 shrink-0">
            <NavLink
              to="/"
              aria-label={`${APP_NAME} home`}
              className="flex items-center gap-2.5 min-w-0 overflow-hidden group focus:outline-none"
            >
              {shopLogo ? (
                <img
                  src={shopLogo}
                  alt={profile?.name || APP_NAME}
                  className="h-8 w-8 shrink-0 rounded-lg object-contain border border-gray-200 bg-white p-0.5 shadow-xs"
                  data-testid="sidebar-shop-logo"
                />
              ) : (
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white font-bold text-xs shadow-xs"
                  data-testid="sidebar-default-logo"
                >
                  MTC
                </div>
              )}
              <div className="leading-tight min-w-0">
                <p className="font-bold text-sm text-gray-900 tracking-tight truncate group-hover:text-blue-600 transition-colors">
                  {profile?.name || "MyTownCart"}
                </p>
                <p className="text-[10px] uppercase font-semibold text-blue-600 tracking-wider truncate">
                  Billing POS
                </p>
              </div>
            </NavLink>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors shrink-0"
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          </div>
        )}

        {/* Navigation Items */}
        <div className="relative flex-1 min-h-0 flex flex-col">
          <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-3">
            {NAV_GROUPS.map((group, gIdx) => (
              <div key={gIdx} className="space-y-1">
                {!collapsed && group.labelKey ? (
                  <div className="px-3 pt-2 pb-1 text-xs font-bold uppercase tracking-wider text-gray-600">
                    {t(group.labelKey)}
                  </div>
                ) : collapsed && gIdx > 0 ? (
                  <div className="my-2 border-t border-gray-100" />
                ) : null}
                {group.items.filter((item) => isOwner || !isOwnerOnlyPath(item.to)).map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === "/"}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
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
              </div>
            ))}
          </nav>
          {/* Bottom scroll hint gradient */}
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-white to-transparent" />
        </div>

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
                    title={t("nav.shortcuts_help")}
                    aria-label={t("nav.shortcuts_help")}
                    className="p-1.5 rounded-md text-gray-600 hover:bg-gray-200 hover:text-gray-900 transition-colors"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <rect x="2" y="4" width="20" height="16" rx="2" strokeWidth={1.8} />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    data-testid="sidebar-lock-btn"
                    onClick={() => void handleQuickLockClick()}
                    title={t("users.quick_lock")}
                    aria-label={t("users.quick_lock")}
                    className="p-1.5 rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-800 transition-colors"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </button>
                </div>
              </div>
              <UpdateAvailableButton />
              <div className="flex items-center justify-between text-[10px] text-gray-500 font-mono">
                <span>v{APP_VERSION}</span>
                <span className="inline-flex items-center gap-1 text-green-600 font-sans font-medium shrink-0">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  Online
                </span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <UpdateAvailableButton collapsed />
              <button
                type="button"
                data-testid="sidebar-shortcuts-btn"
                onClick={() => setShowShortcuts(true)}
                title={t("nav.shortcuts_help")}
                aria-label={t("nav.shortcuts_help")}
                className="p-1.5 rounded text-gray-600 hover:bg-gray-200 hover:text-gray-900"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <rect x="2" y="4" width="20" height="16" rx="2" strokeWidth={1.8} />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
                </svg>
              </button>
              <button
                type="button"
                data-testid="sidebar-lock-btn"
                onClick={() => void handleQuickLockClick()}
                title={t("users.quick_lock")}
                aria-label={t("users.quick_lock")}
                className="p-1.5 rounded text-gray-500 hover:bg-gray-200 hover:text-gray-800"
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
          onClose={() => setIsLocked(false)}
          onSuccess={(user) => {
            setCurrentUser(user);
            setIsLocked(false);
          }}
        />
      )}

      {/* No Users Configured Modal */}
      {showNoUsersModal && (
        <Modal
          isOpen={showNoUsersModal}
          onClose={() => setShowNoUsersModal(false)}
          title={t("users.lock_no_users_title")}
          maxWidth="max-w-sm"
          dataTestId="no-users-modal"
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {t("users.lock_no_users_msg")}
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
              <Button variant="secondary" onClick={() => setShowNoUsersModal(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setShowNoUsersModal(false);
                  navigate("/users");
                }}
              >
                {t("users.go_to_users")}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Keyboard Shortcuts Cheat Sheet */}
      <KeyboardShortcutsModal
        isOpen={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />
    </div>
  );
}
