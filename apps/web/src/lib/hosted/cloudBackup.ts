// SPDX-License-Identifier: Apache-2.0
/**
 * Automatic encrypted cloud backup for the hosted web app (D13).
 *
 * Snapshot = gzip("MTWS1" + JSON state) sealed with the same AES-256-GCM /
 * HKDF recovery-key scheme as desktop backups (D5), then uploaded to the
 * seller's MyTownCart account as ciphertext. Who else can open it depends on
 * the key mode (backupKey.ts): by default MyTownCart keeps the key so a new
 * device restores on sign-in; in private mode only the seller's key opens it.
 *
 * Schedule: soon after the first change, then at most every 30 minutes while
 * there are unsaved changes, right after a day-end closure, and when the
 * connection comes back. Billing never waits for any of this.
 */
import { useSyncExternalStore } from "react";

import { APP_VERSION } from "@mytowncart-billing/core";
import {
  decryptSnapshot,
  encryptSnapshot,
  parseRecoveryKey,
} from "@mytowncart-billing/backup";
import { MarketplaceError, type CloudBackup } from "@mytowncart-billing/connector-mytowncart";
import { decodeMemoryState, encodeMemoryState, type MemoryState } from "@mytowncart-billing/storage";

import { getConnector } from "../marketplace";
import { keyForBackup } from "./backupKey";
import { idbGet, idbSet } from "./idb";
import type { PersistedRepository } from "./persistedRepository";

export const WEB_BACKUP_FORMAT = "web-state-v1";
export const WEB_BACKUP_SCHEMA = 1;
const LAST_SUCCESS_KEY = "cloudBackup.lastSuccessAt";
/** Survives a reload: changes from the last session not yet in the cloud. */
const PENDING_KEY = "cloudBackup.pending";
export const MIN_INTERVAL_MS = 30 * 60_000;
const FIRST_BACKUP_DELAY_MS = 60_000;
const TICK_MS = 60_000;

export interface CloudBackupStatus {
  lastSuccessAt: string | null;
  lastError: string | null;
  running: boolean;
  /** Changes made since the last successful backup. */
  pending: boolean;
}

let status: CloudBackupStatus = { lastSuccessAt: null, lastError: null, running: false, pending: false };
const subscribers = new Set<() => void>();

function setStatus(patch: Partial<CloudBackupStatus>): void {
  status = { ...status, ...patch };
  for (const fn of subscribers) fn();
}

export function getCloudBackupStatus(): CloudBackupStatus {
  return status;
}

export function useCloudBackupStatus(): CloudBackupStatus {
  return useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    () => status,
  );
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export const gzip = (bytes: Uint8Array) => transform(bytes, new CompressionStream("gzip"));
export const gunzip = (bytes: Uint8Array) => transform(bytes, new DecompressionStream("gzip"));

/** Seal a repository state for upload. Exported for tests. */
export async function sealState(state: MemoryState, key: Uint8Array, createdAt: Date): Promise<Uint8Array> {
  return encryptSnapshot(await gzip(encodeMemoryState(state)), key, {
    schemaVersion: WEB_BACKUP_SCHEMA,
    appVersion: APP_VERSION,
    createdAt: createdAt.toISOString(),
  });
}

export type OpenResult =
  | { ok: true; state: MemoryState; key: Uint8Array; createdAt: string }
  | { ok: false; error: "bad_key" | "wrong_key" | "corrupt" };

/** Decrypt and decode a backup without applying it. Exported for tests. */
export async function openSealed(ciphertext: Uint8Array, typedKey: string | Uint8Array): Promise<OpenResult> {
  const key = typeof typedKey === "string" ? parseRecoveryKey(typedKey) : typedKey;
  if (key === null) return { ok: false, error: "bad_key" };
  let plain: Uint8Array;
  let createdAt: string;
  try {
    const out = await decryptSnapshot(ciphertext, key);
    plain = out.plaintext;
    createdAt = out.header.created_at;
  } catch (err) {
    return { ok: false, error: err instanceof Error && err.message === "wrong_key" ? "wrong_key" : "corrupt" };
  }
  try {
    return { ok: true, state: decodeMemoryState(await gunzip(plain)), key, createdAt };
  } catch {
    return { ok: false, error: "corrupt" };
  }
}

export async function listWebBackups(): Promise<CloudBackup[]> {
  const all = await getConnector().listBackups();
  return all.filter((b) => b.cryptoParams.format === WEB_BACKUP_FORMAT);
}

export async function downloadAndOpen(id: string, typedKey: string | Uint8Array): Promise<OpenResult> {
  return openSealed(await getConnector().downloadBackup(id), typedKey);
}

let running: Promise<boolean> | null = null;
let lastAttemptAt = 0;
let retryNotBefore = 0;
let onSignedOut: (() => void) | null = null;

/** Back up now. Resolves true on success; never throws. */
export function backupNow(persisted: PersistedRepository): Promise<boolean> {
  if (running) return running;
  running = (async () => {
    lastAttemptAt = Date.now();
    setStatus({ running: true });
    try {
      const key = await keyForBackup();
      await persisted.flush();
      // Taken before the async seal/upload: a change made meanwhile keeps
      // `pending` set and is picked up by the next run.
      const changedDuringRun = { value: false };
      const stop = persisted.onMutation(() => {
        changedDuringRun.value = true;
      });
      try {
        const now = new Date();
        const sealed = await sealState(structuredClone(persisted.memory.exportState()), key, now);
        await getConnector().uploadBackup(sealed, {
          appVersion: APP_VERSION,
          schemaVersion: WEB_BACKUP_SCHEMA,
          cryptoParams: { format: WEB_BACKUP_FORMAT, cipher: "aes-256-gcm", kdf: "hkdf-sha-256", compression: "gzip" },
        });
        await idbSet(LAST_SUCCESS_KEY, now.toISOString());
        if (!changedDuringRun.value) await idbSet(PENDING_KEY, false);
        setStatus({ lastSuccessAt: now.toISOString(), lastError: null, pending: changedDuringRun.value });
      } finally {
        stop();
      }
      return true;
    } catch (err) {
      if (err instanceof MarketplaceError) {
        if (err.code === "unauthorized" || err.code === "expired_token") onSignedOut?.();
        if (err.retryAfterSeconds) retryNotBefore = Date.now() + err.retryAfterSeconds * 1000;
      }
      setStatus({ lastError: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      setStatus({ running: false });
      running = null;
    }
  })();
  return running;
}

/**
 * Start the background schedule. `signedOut` is called when the server says
 * the token is no longer valid, so the app can ask the seller to sign in.
 * Returns a stop function.
 */
export async function startCloudBackupScheduler(
  persisted: PersistedRepository,
  signedOut: () => void,
): Promise<() => void> {
  onSignedOut = signedOut;
  const last = (await idbGet<string>(LAST_SUCCESS_KEY)) ?? null;
  const pendingFromLastSession = (await idbGet<boolean>(PENDING_KEY)) === true;
  setStatus({ lastSuccessAt: last, pending: pendingFromLastSession });
  let firstChangeAt = 0;

  const due = (now: number): boolean => {
    if (!status.pending || status.running || now < retryNotBefore) return false;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
    if (status.lastSuccessAt === null && lastAttemptAt === 0) return now - firstChangeAt >= FIRST_BACKUP_DELAY_MS;
    return now - lastAttemptAt >= MIN_INTERVAL_MS;
  };

  const tick = () => {
    if (due(Date.now())) void backupNow(persisted);
  };

  const stopListening = persisted.onMutation((method) => {
    if (!status.pending) {
      firstChangeAt = Date.now();
      void idbSet(PENDING_KEY, true);
    }
    setStatus({ pending: true });
    // Close of day: back up straight away (still at most one run at a time).
    if (method === "createDayEndClosure" && Date.now() - lastAttemptAt > 2 * 60_000) {
      void backupNow(persisted);
    }
  });
  const timer = setInterval(tick, TICK_MS);
  window.addEventListener("online", tick);

  return () => {
    stopListening();
    clearInterval(timer);
    window.removeEventListener("online", tick);
    onSignedOut = null;
  };
}
