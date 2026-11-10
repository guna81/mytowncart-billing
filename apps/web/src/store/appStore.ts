// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";

import { APP_VERSION } from "@mytowncart-billing/core";
import type { DayEndClosure, ShopProfile, User } from "@mytowncart-billing/storage";
import { isInTauri } from "../lib/tauri";
import { checkForUpdate, type UpdateCheckResult } from "../lib/updateCheck";

export interface PrintJob {
  billId?: number;
  creditNoteId?: number;
  dayEndData?: DayEndClosure;
  variant: "receipt-58" | "receipt-80" | "invoice-a4" | "credit-note-80" | "credit-note-a4" | "z-report";
}

export type SupportedLocale = "en" | "hi" | "ta";

interface AppState {
  booted: boolean;
  profile: ShopProfile | null;
  shopLogo: string | null;
  /** Set once `me()` reports it; drives the honest "pending store approval" state. */
  sellerIsApproved: boolean | null;
  setSellerIsApproved(approved: boolean | null): void;
  setProfile(profile: ShopProfile | null): void;
  setShopLogo(shopLogo: string | null): void;
  setBooted(booted: boolean): void;

  printJob: PrintJob | null;
  requestPrint(job: PrintJob): void;
  clearPrintJob(): void;

  /** Bumped whenever bills/items change so list screens can refetch. */
  dataVersion: number;
  bumpDataVersion(): void;

  /** Quick lock terminal state */
  isLocked: boolean;
  setIsLocked(locked: boolean): void;
  currentUser: User | null;
  setCurrentUser(user: User | null): void;
  /** True once any active user has a PIN: from then on a login is required. */
  loginRequired: boolean;
  setLoginRequired(required: boolean): void;

  /** App UI Locale */
  locale: SupportedLocale;
  setAppLocale(locale: SupportedLocale): void;

  /** Update notifications (decision B4-3) */
  updateInfo: { tag: string; url: string } | null;
  updateChecking: boolean;
  updateCheckResult: UpdateCheckResult | null;
  runUpdateCheck(force?: boolean): Promise<UpdateCheckResult | null>;

  /** Auto sync products and stock */
  autoSyncEnabled: boolean;
  setAutoSyncEnabled(enabled: boolean): void;
  isSyncing: boolean;
  setIsSyncing(isSyncing: boolean): void;
}

const initialLocale =
  typeof localStorage !== "undefined" &&
  (localStorage.getItem("mtc_locale") === "hi" || localStorage.getItem("mtc_locale") === "ta")
    ? (localStorage.getItem("mtc_locale") as SupportedLocale)
    : "en";

export const useAppStore = create<AppState>((set) => ({
  booted: false,
  profile: null,
  shopLogo: null,
  sellerIsApproved: null,
  setSellerIsApproved: (sellerIsApproved) => set({ sellerIsApproved }),
  setProfile: (profile) => set({ profile }),
  setShopLogo: (shopLogo) => set({ shopLogo }),
  setBooted: (booted) => set({ booted }),

  printJob: null,
  requestPrint: (job) => set({ printJob: job }),
  clearPrintJob: () => set({ printJob: null }),

  dataVersion: 0,
  bumpDataVersion: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),

  isLocked: false,
  setIsLocked: (isLocked) => set({ isLocked }),
  currentUser: null,
  setCurrentUser: (currentUser) => set({ currentUser }),
  loginRequired: false,
  setLoginRequired: (loginRequired) => set({ loginRequired }),

  locale: initialLocale,
  setAppLocale: (locale) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("mtc_locale", locale);
    }
    set({ locale });
  },

  updateInfo: null,
  updateChecking: false,
  updateCheckResult: null,
  autoSyncEnabled: true,
  setAutoSyncEnabled: (autoSyncEnabled) => set({ autoSyncEnabled }),
  isSyncing: false,
  setIsSyncing: (isSyncing) => set({ isSyncing }),
  runUpdateCheck: async (force?: boolean) => {
    if (!isInTauri()) {
      return null;
    }
    set({ updateChecking: true });
    try {
      const result = await checkForUpdate({ current: APP_VERSION, force });
      if (result.available && result.tag && result.url) {
        set({
          updateInfo: { tag: result.tag, url: result.url },
          updateCheckResult: result,
        });
      } else {
        if (!result.failed) {
          set({ updateInfo: null });
        }
        set({ updateCheckResult: result });
      }
      return result;
    } finally {
      set({ updateChecking: false });
    }
  },
}));
