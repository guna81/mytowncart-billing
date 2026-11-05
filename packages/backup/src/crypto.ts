// SPDX-License-Identifier: Apache-2.0
/**
 * Recovery keys and the encrypted-backup envelope (B3, roadmap §8.7).
 *
 * A 160-bit random key is shown once as 8 groups of 4 base32 characters.
 * A per-backup random salt feeds HKDF-SHA-256 to derive the AES-256-GCM key,
 * so one recovery key can (in principle) decrypt many backups without
 * re-using an AES key. The plaintext header doubles as the GCM additional
 * authenticated data, so the version/schema fields cannot be tampered with.
 *
 * File layout: "MTCB1" · u32 BE header length · header JSON (UTF-8) ·
 * AES-GCM ciphertext || 16-byte tag.
 */

export const BACKUP_MAGIC = "MTCB1";
export const RECOVERY_KEY_BYTES = 20;
export const RECOVERY_KEY_GROUPS = 8;
export const RECOVERY_KEY_GROUP_LEN = 4;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 4096;
const HKDF_INFO = "mytowncart-billing backup v1";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface BackupHeader {
  v: 1;
  salt_b64: string;
  nonce_b64: string;
  cipher: "aes-256-gcm";
  kdf: "hkdf-sha-256";
  schema_version: number;
  app_version: string;
  created_at: string;
}

export interface WebCryptoLike {
  subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
}

/** One place for the DOM type, so unit tests can inject Node's WebCrypto. */
export function webCrypto(): WebCryptoLike {
  const c = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (!c?.subtle) throw new Error("This browser cannot encrypt backups (no WebCrypto).");
  return c;
}

export function randomBytes(length: number): Uint8Array {
  return new Uint8Array(webCrypto().getRandomValues(new Uint8Array(length)));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error(`invalid recovery key character: ${ch}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 8 groups of 4 characters, e.g. `K3QA 7XPM …` — easy to read aloud. */
export function formatRecoveryKey(raw: Uint8Array): string {
  const encoded = toBase32(raw);
  const groups: string[] = [];
  for (let i = 0; i < encoded.length; i += RECOVERY_KEY_GROUP_LEN) {
    groups.push(encoded.slice(i, i + RECOVERY_KEY_GROUP_LEN));
  }
  return groups.join(" ");
}

/**
 * Accepts a key typed back with any spacing, dashes or lower case. Returns
 * the raw bytes, or null when the key is not exactly one we could have issued.
 */
export function parseRecoveryKey(text: string): Uint8Array | null {
  const cleaned = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const expected = Math.ceil((RECOVERY_KEY_BYTES * 8) / 5);
  if (cleaned.length !== expected) return null;
  try {
    return fromBase32(cleaned);
  } catch {
    return null;
  }
}

export function generateRecoveryKey(): { raw: Uint8Array; text: string } {
  const raw = randomBytes(RECOVERY_KEY_BYTES);
  return { raw, text: formatRecoveryKey(raw) };
}

async function deriveKey(key: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const crypto = webCrypto();
  const material = await crypto.subtle.importKey("raw", key as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: new TextEncoder().encode(HKDF_INFO) as BufferSource,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function encodeHeader(header: BackupHeader): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(header));
}

function isHeader(value: unknown): value is BackupHeader {
  if (typeof value !== "object" || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    h.v === 1 &&
    h.cipher === "aes-256-gcm" &&
    h.kdf === "hkdf-sha-256" &&
    typeof h.salt_b64 === "string" &&
    typeof h.nonce_b64 === "string" &&
    typeof h.schema_version === "number" &&
    typeof h.app_version === "string" &&
    typeof h.created_at === "string"
  );
}

export async function encryptSnapshot(
  plaintext: Uint8Array,
  key: Uint8Array,
  meta: { schemaVersion: number; appVersion: string; createdAt: string },
): Promise<Uint8Array> {
  if (key.length !== RECOVERY_KEY_BYTES) throw new Error("recovery key has the wrong length");
  const crypto = webCrypto();
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header: BackupHeader = {
    v: 1,
    salt_b64: toBase64(salt),
    nonce_b64: toBase64(nonce),
    cipher: "aes-256-gcm",
    kdf: "hkdf-sha-256",
    schema_version: meta.schemaVersion,
    app_version: meta.appVersion,
    created_at: meta.createdAt,
  };
  const headerBytes = encodeHeader(header);
  const aesKey = await deriveKey(key, salt);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: headerBytes as BufferSource },
      aesKey,
      plaintext as BufferSource,
    ),
  );
  const out = new Uint8Array(BACKUP_MAGIC.length + 4 + headerBytes.length + sealed.length);
  out.set(new TextEncoder().encode(BACKUP_MAGIC), 0);
  new DataView(out.buffer).setUint32(BACKUP_MAGIC.length, headerBytes.length, false);
  out.set(headerBytes, BACKUP_MAGIC.length + 4);
  out.set(sealed, BACKUP_MAGIC.length + 4 + headerBytes.length);
  return out;
}

/** Cheap structural check; decrypting is what actually proves authenticity. */
export function isBackupFile(bytes: Uint8Array): boolean {
  if (bytes.length < BACKUP_MAGIC.length + 4 + TAG_BYTES) return false;
  return new TextDecoder().decode(bytes.subarray(0, BACKUP_MAGIC.length)) === BACKUP_MAGIC;
}

export async function decryptSnapshot(
  file: Uint8Array,
  key: Uint8Array,
): Promise<{ plaintext: Uint8Array; header: BackupHeader }> {
  if (!isBackupFile(file)) throw new Error("not_found");
  const crypto = webCrypto();
  const lengthAt = BACKUP_MAGIC.length;
  const headerLen = new DataView(file.buffer, file.byteOffset + lengthAt, 4).getUint32(0, false);
  if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) throw new Error("corrupt");
  const headerStart = lengthAt + 4;
  const headerBytes = file.subarray(headerStart, headerStart + headerLen);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(headerBytes));
  } catch {
    throw new Error("corrupt");
  }
  if (!isHeader(parsed)) throw new Error("corrupt");

  const salt = fromBase64(parsed.salt_b64);
  const nonce = fromBase64(parsed.nonce_b64);
  if (salt.length !== SALT_BYTES || nonce.length !== NONCE_BYTES) throw new Error("corrupt");

  const aesKey = await deriveKey(key, salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: headerBytes as BufferSource },
      aesKey,
      file.subarray(headerStart + headerLen) as BufferSource,
    );
  } catch {
    throw new Error("wrong_key");
  }
  return { plaintext: new Uint8Array(plaintext), header: parsed };
}
