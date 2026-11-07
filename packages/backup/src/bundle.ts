// SPDX-License-Identifier: Apache-2.0
/**
 * Master backup bundle (format v2): the plaintext inside the encrypted
 * envelope. Layout, written by the desktop shell (`backup.rs`):
 *
 *   "MTBD1" · u32 BE manifest length · manifest JSON · db.gz · photo bytes
 *
 * Only the manifest is read here, so the restore screen can show what a
 * backup contains (and "verify" can prove it opens) without restoring it.
 */

export const BUNDLE_MAGIC = "MTBD1";
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export interface BundleManifest {
  v: 1;
  db_len: number;
  item_count: number;
  photos: { name: string; len: number }[];
}

export interface BackupSummary {
  /** 1 = database only (older backup), 2 = database + photos. */
  format: 1 | 2;
  itemCount: number | null;
  photoCount: number | null;
  photoBytes: number | null;
}

export function isBundle(plain: Uint8Array): boolean {
  return (
    plain.length >= BUNDLE_MAGIC.length + 4 &&
    new TextDecoder().decode(plain.subarray(0, BUNDLE_MAGIC.length)) === BUNDLE_MAGIC
  );
}

/** Reads and sanity-checks the manifest, including that the lengths add up. */
export function readBundleManifest(plain: Uint8Array): BundleManifest | null {
  if (!isBundle(plain)) return null;
  const at = BUNDLE_MAGIC.length;
  const manifestLen = new DataView(plain.buffer, plain.byteOffset + at, 4).getUint32(0, false);
  if (manifestLen === 0 || manifestLen > MAX_MANIFEST_BYTES) return null;
  const start = at + 4;
  if (start + manifestLen > plain.length) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plain.subarray(start, start + manifestLen)));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Partial<BundleManifest>;
  if (
    m.v !== 1 ||
    typeof m.db_len !== "number" ||
    typeof m.item_count !== "number" ||
    !Array.isArray(m.photos) ||
    !m.photos.every((p) => typeof p?.name === "string" && typeof p?.len === "number")
  ) {
    return null;
  }
  const total = start + manifestLen + m.db_len + m.photos.reduce((sum, p) => sum + p.len, 0);
  if (total !== plain.length) return null;
  return m as BundleManifest;
}

export function summarizeBackup(plain: Uint8Array): BackupSummary | null {
  if (!isBundle(plain)) {
    return { format: 1, itemCount: null, photoCount: null, photoBytes: null };
  }
  const manifest = readBundleManifest(plain);
  if (manifest === null) return null;
  return {
    format: 2,
    itemCount: manifest.item_count,
    photoCount: manifest.photos.length,
    photoBytes: manifest.photos.reduce((sum, p) => sum + p.len, 0),
  };
}
