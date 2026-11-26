// SPDX-License-Identifier: Apache-2.0
/**
 * Who holds the hosted web app's backup key (D13 rev).
 *
 * `managed` (default): MyTownCart keeps a sealed copy of the key, so signing
 * in on a new device brings the shop back with nothing to type. `private`
 * (opt-in, Settings): the seller keeps their own recovery key and MyTownCart
 * cannot open the backups.
 *
 * The key always also lives in this browser (sealed by the device key in
 * IndexedDB, keystore.ts). Billing never waits on the server: if it cannot be
 * reached, a key is made locally and handed to the server before the next
 * backup is uploaded.
 */
import { formatRecoveryKey, generateRecoveryKey, parseRecoveryKey } from "@mytowncart-billing/backup";
import { MarketplaceError, type BackupKeySetting } from "@mytowncart-billing/connector-mytowncart";

import { revealRecoveryKey, saveRecoveryKey } from "../cryptoStore";
import { getConnector } from "../marketplace";
import { idbGet, idbSet } from "./idb";
import { hostedInvoke } from "./keystore";

export type KeyMode = "managed" | "private";

const MODE_KEY = "backupKey.mode";
/** True once the server confirmed it holds this browser's key (managed mode). */
const ESCROWED_KEY = "backupKey.escrowed";

function isAuthError(err: unknown): boolean {
  return err instanceof MarketplaceError && (err.code === "unauthorized" || err.code === "expired_token");
}

export async function localKey(): Promise<Uint8Array | null> {
  const text = await revealRecoveryKey(hostedInvoke);
  return text === null ? null : parseRecoveryKey(text);
}

export async function keyMode(): Promise<KeyMode> {
  return (await idbGet<KeyMode>(MODE_KEY)) === "private" ? "private" : "managed";
}

async function storeLocal(key: Uint8Array, mode: KeyMode, escrowed: boolean): Promise<void> {
  await saveRecoveryKey(hostedInvoke, key);
  await idbSet(MODE_KEY, mode);
  await idbSet(ESCROWED_KEY, escrowed);
}

/** Record the key a backup was restored with, so later backups use it too. */
export async function rememberRestoredKey(key: Uint8Array, mode: KeyMode, escrowed: boolean): Promise<void> {
  await storeLocal(key, mode, escrowed);
}

/**
 * Make sure this browser has a backup key before the app opens.
 * "private_setup": the shop keeps its own key and this browser has none, so
 * the seller must be shown a new recovery key to save.
 * Throws only for a sign-in problem (the caller asks the seller to sign in).
 */
export async function ensureBackupKey(): Promise<"ready" | "private_setup"> {
  if ((await localKey()) !== null) return "ready";
  let server: BackupKeySetting | null;
  try {
    server = await getConnector().getBackupKey();
  } catch (err) {
    if (isAuthError(err)) throw err;
    // Offline or key storage down: start with a local key, hand it over later.
    await storeLocal(generateRecoveryKey().raw, "managed", false);
    return "ready";
  }
  if (server?.mode === "managed") {
    await storeLocal(server.key, "managed", true);
    return "ready";
  }
  if (server?.mode === "private") return "private_setup";
  await storeLocal(generateRecoveryKey().raw, "managed", false);
  try {
    await keyForBackup();
  } catch (err) {
    if (isAuthError(err)) throw err;
  }
  return "ready";
}

/**
 * The key to seal the next backup with. In managed mode, first make sure the
 * server holds it; if another device set up a different key first, switch to
 * that one (nothing was uploaded with ours yet, because this runs before every
 * upload). Sign-in errors are thrown; other failures still return the local
 * key so the backup is attempted anyway.
 */
export async function keyForBackup(): Promise<Uint8Array> {
  const key = await localKey();
  if (key === null) throw new Error("no_recovery_key");
  if ((await keyMode()) !== "managed" || (await idbGet<boolean>(ESCROWED_KEY)) === true) return key;
  const connector = getConnector();
  try {
    await connector.putBackupKey({ mode: "managed", key });
    await idbSet(ESCROWED_KEY, true);
    return key;
  } catch (err) {
    if (isAuthError(err)) throw err;
    if (err instanceof MarketplaceError && err.code === "key_exists") {
      const server = await connector.getBackupKey();
      if (server?.mode === "managed") {
        await storeLocal(server.key, "managed", true);
        return server.key;
      }
      // The seller chose to keep their own key on another device.
      if (server?.mode === "private") await idbSet(MODE_KEY, "private");
    }
    return key;
  }
}

/** A new key for private mode, shown to the seller before anything changes. */
export function newPrivateKey(): { raw: Uint8Array; text: string } {
  return generateRecoveryKey();
}

/**
 * Switch to "I keep my own key": the server's copy is wiped and new backups
 * use `fresh`, a key MyTownCart never saw. Older backups (sealed with the
 * previous, server-known key) age out under the normal retention.
 */
export async function switchToPrivate(fresh: Uint8Array): Promise<void> {
  await getConnector().putBackupKey({ mode: "private" }, { replace: true });
  await storeLocal(fresh, "private", false);
}

/** Let MyTownCart keep this browser's key again. */
export async function switchToManaged(): Promise<void> {
  const key = await localKey();
  if (key === null) throw new Error("no_recovery_key");
  await getConnector().putBackupKey({ mode: "managed", key }, { replace: true });
  await idbSet(MODE_KEY, "managed");
  await idbSet(ESCROWED_KEY, true);
}

/** The server-held key for restoring on a new device, or null (private, none, or unreachable). */
export async function serverKeySetting(): Promise<{ mode: KeyMode; key: Uint8Array | null } | null> {
  try {
    const server = await getConnector().getBackupKey();
    if (server === null) return null;
    return server.mode === "managed" ? { mode: "managed", key: server.key } : { mode: "private", key: null };
  } catch (err) {
    if (isAuthError(err)) throw err;
    return null;
  }
}

export async function formattedLocalKey(): Promise<string | null> {
  const key = await localKey();
  return key === null ? null : formatRecoveryKey(key);
}
