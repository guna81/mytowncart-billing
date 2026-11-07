// SPDX-License-Identifier: Apache-2.0
/**
 * Role helpers for the UI. These only mirror what the Rust shell enforces
 * (`auth.rs`): hiding a button is a convenience, Rust is what refuses the call.
 */

import { useAppStore } from "../store/appStore";
import { getRepository } from "./repository";

/** Routes only an owner may open (the matching commands are owner-only in Rust). */
export const OWNER_ONLY_ROUTES: readonly string[] = [
  "/users",
  "/settings",
  "/suppliers",
  "/purchases",
  "/stock-audit",
  "/mytowncart",
  "/items/new",
];

export function isOwnerOnlyPath(path: string): boolean {
  return (
    OWNER_ONLY_ROUTES.some((p) => path === p || path.startsWith(`${p}/`)) ||
    /^\/items\/\d+\/edit$/.test(path)
  );
}

/** True while no PIN login is needed (nobody has set a PIN yet) or an owner is logged in. */
export function useIsOwner(): boolean {
  const loginRequired = useAppStore((s) => s.loginRequired);
  const role = useAppStore((s) => s.currentUser?.role);
  return !loginRequired || role === "owner";
}

/** Re-reads the user list: is login required now, and if so is the terminal locked? */
export async function refreshLoginState(): Promise<void> {
  const store = useAppStore.getState();
  try {
    const users = await getRepository().listUsers();
    const required = users.some((u) => u.isActive && u.hasPin);
    store.setLoginRequired(required);
    if (required && !useAppStore.getState().currentUser) store.setIsLocked(true);
    if (!required) store.setCurrentUser(null);
  } catch {
    // Leave the current state; the lock screen still protects an already-locked terminal.
  }
}
