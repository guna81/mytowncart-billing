// SPDX-License-Identifier: Apache-2.0
/**
 * Byte encoding of a `MemoryRepository` state snapshot, used by the hosted web
 * app (D13) for its encrypted cloud backup. Platform-neutral: JSON with tagged
 * `Map` and `Uint8Array` values, gzip-free (the caller compresses).
 *
 *   "MTWS1" · UTF-8 JSON `{ v: 1, state }`
 *
 * This is NOT the desktop backup bundle (SQLite + photos, "MTBD1"); a desktop
 * backup cannot be restored in the browser or the other way round.
 */
import type { MemoryState } from "./memory";

export const WEB_STATE_MAGIC = "MTWS1";

interface Tagged {
  __t: "map" | "u8";
  v: unknown;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function replacer(this: unknown, _key: string, value: unknown): unknown {
  if (value instanceof Map) return { __t: "map", v: [...value.entries()] } satisfies Tagged;
  if (value instanceof Uint8Array) return { __t: "u8", v: toBase64(value) } satisfies Tagged;
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null && "__t" in value && "v" in value) {
    const tagged = value as Tagged;
    if (tagged.__t === "map" && Array.isArray(tagged.v)) return new Map(tagged.v as [unknown, unknown][]);
    if (tagged.__t === "u8" && typeof tagged.v === "string") return fromBase64(tagged.v);
  }
  return value;
}

export function encodeMemoryState(state: MemoryState): Uint8Array {
  const json = JSON.stringify({ v: 1, state }, replacer);
  const body = new TextEncoder().encode(json);
  const out = new Uint8Array(WEB_STATE_MAGIC.length + body.length);
  out.set(new TextEncoder().encode(WEB_STATE_MAGIC), 0);
  out.set(body, WEB_STATE_MAGIC.length);
  return out;
}

export function isWebStateBackup(bytes: Uint8Array): boolean {
  return (
    bytes.length > WEB_STATE_MAGIC.length &&
    new TextDecoder().decode(bytes.subarray(0, WEB_STATE_MAGIC.length)) === WEB_STATE_MAGIC
  );
}

/** Throws `not_web_state` / `corrupt` on anything that is not a v1 snapshot. */
export function decodeMemoryState(bytes: Uint8Array): MemoryState {
  if (!isWebStateBackup(bytes)) throw new Error("not_web_state");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(WEB_STATE_MAGIC.length)), reviver);
  } catch {
    throw new Error("corrupt");
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { state?: unknown }).state !== "object" ||
    (parsed as { state?: unknown }).state === null
  ) {
    throw new Error("corrupt");
  }
  return (parsed as { state: MemoryState }).state;
}
