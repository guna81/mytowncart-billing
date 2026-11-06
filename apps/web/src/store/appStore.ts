// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";

import type { DayEndClosure, ShopProfile, User } from "@mytowncart-billing/storage";

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
  /** Set once `me()` reports it; drives the honest "pending store approval" state. */
  sellerIsApproved: boolean | null;
  setSellerIsApproved(approved: boolean | null): void;
  setProfile(profile: ShopProfile | null): void;
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

  /** App UI Locale */
  locale: SupportedLocale;
  setAppLocale(locale: SupportedLocale): void;
}

const initialLocale =
  typeof localStorage !== "undefined" &&
  (localStorage.getItem("mtc_locale") === "hi" || localStorage.getItem("mtc_locale") === "ta")
    ? (localStorage.getItem("mtc_locale") as SupportedLocale)
    : "en";

export const useAppStore = create<AppState>((set) => ({
  booted: false,
  profile: null,
  sellerIsApproved: null,
  setSellerIsApproved: (sellerIsApproved) => set({ sellerIsApproved }),
  setProfile: (profile) => set({ profile }),
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

  locale: initialLocale,
  setAppLocale: (locale) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("mtc_locale", locale);
    }
    set({ locale });
  },
}));
