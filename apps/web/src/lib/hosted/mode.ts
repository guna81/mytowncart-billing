// SPDX-License-Identifier: Apache-2.0
/**
 * Hosted web app mode (roadmap D2, D13): the same UI served as static files,
 * data in the browser's IndexedDB, MyTownCart sign-in mandatory, and an
 * automatic client-side-encrypted cloud backup. Chosen at build time with
 * `VITE_HOSTED=1` (`pnpm --filter @mytowncart-billing/web build:hosted`), so
 * the desktop build, the LAN browser and the dev server are unchanged.
 */

const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};

export function isHosted(): boolean {
  if (env.VITE_HOSTED !== "1") return false;
  // Never inside the desktop shell, even if a build flag leaked.
  return typeof window === "undefined" ||
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === undefined;
}

/** Client name the seller sees in MyTownCart's connected-apps list. */
export const HOSTED_CLIENT_NAME = "MyTownCart Billing (web)";

/** Where the "Download desktop app" button points. */
export const DESKTOP_DOWNLOAD_URL = "https://billing.mytowncart.com/#download";
