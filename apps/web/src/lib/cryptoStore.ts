// SPDX-License-Identifier: Apache-2.0
/**
 * Recovery-key storage (B3). The key is wrapped as an AES-GCM secret in the
 * OS keychain, so "show my recovery key" works without keeping a key file.
 * It is never written to SQLite, localStorage, or a log; the plaintext exists
 * only in memory while the app is running.
 */
import {
  decryptSnapshot,
  encryptSnapshot,
  formatRecoveryKey,
  fromBase64,
  generateRecoveryKey,
  parseRecoveryKey,
  randomBytes,
  toBase64,
  webCrypto,
  type Invoke,
} from "@mytowncart-billing/backup";

const KEYCHAIN_ENTRY = "backup.recovery-key";
const WRAP_INFO = "mytowncart-billing recovery key wrap";

interface WrappedKey {
  v: 1;
  salt_b64: string;
  nonce_b64: string;
  data_b64: string;
}

async function wrappingKey(salt: Uint8Array): Promise<CryptoKey> {
  // Fixed password: the OS keychain is the secret boundary. The AES key is
  // non-extractable, so the stored blob can only be opened on this machine.
  const password = new TextEncoder().encode("mytowncart-billing key wrap") as BufferSource;
  const base = await webCrypto().subtle.importKey("raw", password, "PBKDF2", false, [
    "deriveKey",
  ]);
  return webCrypto().subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: 100_000,
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function wrapKey(raw: Uint8Array): Promise<string> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const sealed = new Uint8Array(
    await webCrypto().subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: new TextEncoder().encode(WRAP_INFO) as BufferSource },
      await wrappingKey(salt),
      raw as BufferSource,
    ),
  );
  const wrapped: WrappedKey = {
    v: 1,
    salt_b64: toBase64(salt),
    nonce_b64: toBase64(nonce),
    data_b64: toBase64(sealed),
  };
  return JSON.stringify(wrapped);
}

async function unwrapKey(json: string): Promise<Uint8Array | null> {
  try {
    const wrapped = JSON.parse(json) as WrappedKey;
    if (wrapped.v !== 1) return null;
    const salt = fromBase64(wrapped.salt_b64);
    const raw = await webCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(wrapped.nonce_b64) as BufferSource,
        additionalData: new TextEncoder().encode(WRAP_INFO) as BufferSource,
      },
      await wrappingKey(salt),
      fromBase64(wrapped.data_b64) as BufferSource,
    );
    return new Uint8Array(raw);
  } catch {
    return null;
  }
}

async function storedKey(invoke: Invoke): Promise<Uint8Array | null> {
  const stored = await invoke<string | null>("keychain_get", { key: KEYCHAIN_ENTRY });
  return stored === null ? null : unwrapKey(stored);
}

export async function hasRecoveryKey(invoke: Invoke): Promise<boolean> {
  return (await storedKey(invoke)) !== null;
}

/** Creates (or replaces) the key and returns it in display form, shown once. */
export async function createRecoveryKey(invoke: Invoke): Promise<string> {
  const fresh = generateRecoveryKey();
  await invoke("keychain_set", { key: KEYCHAIN_ENTRY, value: await wrapKey(fresh.raw) });
  return fresh.text;
}

export async function revealRecoveryKey(invoke: Invoke): Promise<string | null> {
  const raw = await storedKey(invoke);
  return raw === null ? null : formatRecoveryKey(raw);
}

export async function encryptCurrentDatabase(
  invoke: Invoke,
  meta: { schemaVersion: number; appVersion: string; createdAt: string },
): Promise<Uint8Array> {
  const raw = await storedKey(invoke);
  if (raw === null) throw new Error("no_recovery_key");
  const snapshot = new Uint8Array(await invoke<number[]>("db_snapshot"));
  return encryptSnapshot(snapshot, raw, meta);
}

export type BackupOpenResult =
  | { ok: true; gz: Uint8Array; createdAt: string }
  | { ok: false; error: "bad_key" | "wrong_key" | "not_backup" };

/** Decrypts a chosen backup file with the key the seller types in for it. */
export async function openBackupWithKey(
  invoke: Invoke,
  path: string,
  typedKey: string,
): Promise<BackupOpenResult> {
  const key = parseRecoveryKey(typedKey);
  if (key === null) return { ok: false, error: "bad_key" };
  const file = new Uint8Array(await invoke<number[]>("read_backup_file", { path }));
  try {
    const out = await decryptSnapshot(file, key);
    return { ok: true, gz: out.plaintext, createdAt: out.header.created_at };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    return { ok: false, error: message === "wrong_key" ? "wrong_key" : "not_backup" };
  }
}
