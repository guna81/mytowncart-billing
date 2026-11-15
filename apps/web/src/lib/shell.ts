// SPDX-License-Identifier: Apache-2.0
/** Desktop-shell command callers shared by the backup UI and the auto-backup. */
import type { Invoke, InvokeRaw } from "@mytowncart-billing/backup";

export const invoke: Invoke = async (command, args) => {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(command, args);
};

/** Binary request/response bodies (no JSON number arrays) for large backups. */
export const invokeRaw: InvokeRaw = async (command, args, options) => {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(command, args, options?.headers ? { headers: options.headers } : undefined);
};

/** Native folder / file chooser; null when cancelled. */
export async function pickPath(opts: {
  directory: boolean;
  title: string;
  defaultPath?: string;
}): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen = await open({
      directory: opts.directory,
      multiple: false,
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.directory ? undefined : [{ name: "MyTownCart backup", extensions: ["mtcb"] }],
    });
    return typeof chosen === "string" ? chosen : null;
  } catch (err) {
    console.warn("pickPath failed:", err);
    return null;
  }
}

/**
 * Yes/no confirmation. The Tauri dialog plugin replaces `window.confirm` with an
 * async function, so `!window.confirm(...)` is always false inside the desktop
 * app and the guarded action silently runs (or the call is denied). Use this
 * awaited helper instead; it falls back to `window.confirm` in a plain browser.
 */
export async function confirmAction(message: string): Promise<boolean> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      return await ask(message, { kind: "warning" });
    } catch (err) {
      console.warn("confirmAction failed:", err);
      return false;
    }
  }
  return window.confirm(message);
}
