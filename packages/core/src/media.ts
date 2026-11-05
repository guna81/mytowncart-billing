// SPDX-License-Identifier: Apache-2.0
/**
 * Item photos (B2/D9): the marketplace shows an item only once it has a
 * photo. The browser cannot tell a file's bytes from its name, so this module
 * sniffs the leading bytes, enforces the size cap, and produces a content
 * hash — re-uploading an unchanged photo is skipped by comparing hashes.
 */

export type ImageKind = "jpeg" | "png" | "webp";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const IMAGE_MIME: Record<ImageKind, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** JPEG (`FF D8 FF`), PNG (`89 50 4E 47 0D 0A 1A 0A`), RIFF/WEBP. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "webp";
  }
  return null;
}

interface CryptoLike {
  subtle?: { digest(alg: string, data: Uint8Array): Promise<ArrayBuffer> };
}

/** SHA-256 hex of the photo bytes; null when WebCrypto is unavailable. */
export async function imageHash(bytes: Uint8Array): Promise<string | null> {
  // `lib: ["ES2022"]` has no DOM, so `crypto` is looked up structurally.
  const subtle = (globalThis as { crypto?: CryptoLike }).crypto?.subtle;
  if (!subtle) return null;
  const copy = new Uint8Array(bytes);
  const digest = await subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ImageCheck {
  ok: boolean;
  kind: ImageKind | null;
  /** Human-readable reason when `ok` is false. */
  error: string | null;
}

export function checkImage(file: { size: number }, head: Uint8Array): ImageCheck {
  if (file.size === 0) return { ok: false, kind: null, error: "empty" };
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, kind: null, error: "too_large" };
  const kind = sniffImage(head);
  if (kind === null) return { ok: false, kind: null, error: "not_an_image" };
  return { ok: true, kind, error: null };
}
