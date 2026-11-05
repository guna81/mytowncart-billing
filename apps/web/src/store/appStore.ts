// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";

import type { ShopProfile } from "@mytowncart-billing/storage";

export interface PrintJob {
  billId: number;
  variant: "receipt-58" | "receipt-80" | "invoice-a4";
}

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
}

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
}));
