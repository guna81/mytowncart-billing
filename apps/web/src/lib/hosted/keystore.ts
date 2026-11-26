// SPDX-License-Identifier: Apache-2.0
/**
 * Browser stand-in for the desktop keychain commands (hosted mode). Secrets
 * (the MyTownCart token, the backup recovery key) are sealed with a
 * non-extractable AES-GCM key that never leaves this browser profile, then
 * kept in IndexedDB — never in localStorage, the repository state, a backup,
 * or a log. Exposed as an `Invoke` so `cryptoStore.ts` works unchanged.
 */
import type { Invoke } from "@mytowncart-billing/backup";
import { idbDelete, idbGet, idbSet } from "./idb";

const DEVICE_KEY = "device.key";
const PREFIX = "secret:";

interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

async function deviceKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>(DEVICE_KEY);
  if (existing) return existing;
  const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await idbSet(DEVICE_KEY, fresh);
  return fresh;
}

async function getSecret(key: string): Promise<string | null> {
  const sealed = await idbGet<Sealed>(PREFIX + key);
  if (!sealed) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.iv as BufferSource },
      await deviceKey(),
      sealed.data,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

async function setSecret(key: string, value: string): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    await deviceKey(),
    new TextEncoder().encode(value) as BufferSource,
  );
  await idbSet(PREFIX + key, { iv, data } satisfies Sealed);
}

export const hostedInvoke: Invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
  const key = typeof args?.key === "string" ? args.key : "";
  switch (command) {
    case "keychain_get":
      return (await getSecret(key)) as T;
    case "keychain_set":
      await setSecret(key, String(args?.value ?? ""));
      return undefined as T;
    case "keychain_delete":
      await idbDelete(PREFIX + key);
      return undefined as T;
    default:
      throw new Error(`${command} is not available in the web app`);
  }
};
