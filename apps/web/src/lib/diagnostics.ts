// SPDX-License-Identifier: Apache-2.0
/**
 * B4 pilot diagnostics. OFF by default; the seller opts in in Settings.
 *
 * When on, the app keeps a short in-memory ring of anonymous events (screen
 * opens, failed actions — message text only, no names, bills, customers,
 * tokens or keys) and shows them for the pilot together with an environment
 * summary. Nothing is ever uploaded: the seller copies or saves the report
 * and decides who sees it (zero-spend; no telemetry service exists).
 */
import { APP_NAME, APP_SLUG, APP_VERSION } from "@mytowncart-billing/core";

export const DIAGNOSTICS_KEY = "pilot.diagnostics";

const MAX_EVENTS = 100;

export interface DiagEvent {
  at: string;
  kind: "screen" | "error";
  name: string;
  /** For errors only: the message (never a payload or a key). */
  detail?: string;
}

let enabled = false;
let events: DiagEvent[] = [];

export function diagnosticsEnabled(): boolean {
  return enabled;
}

export function setDiagnosticsEnabled(on: boolean): void {
  const turningOn = on && !enabled;
  enabled = on;
  if (!on) events = [];
  if (turningOn) recordEvent("screen", "diagnostics on");
}

/** Redacts anything that looks like a secret before it can be recorded. */
export function redact(text: string): string {
  return text
    // 8 groups of 4 base32 characters, the format `formatRecoveryKey` shows.
    .replace(/(^|[^A-Z2-7])[A-Z2-7]{4}(?:[ -][A-Z2-7]{4}){7}(?![A-Z2-7])/g, "$1[recovery key]")
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\b/g, "[token]")
    .slice(0, 300);
}

export function recordEvent(kind: DiagEvent["kind"], name: string, detail?: string): void {
  if (!enabled) return;
  const event: DiagEvent = {
    at: new Date().toISOString(),
    kind,
    name: name.slice(0, 80),
    ...(kind === "error" && detail !== undefined ? { detail: redact(detail) } : {}),
  };
  events = [...events.slice(-(MAX_EVENTS - 1)), event];
}

export function recordedEvents(): readonly DiagEvent[] {
  return events;
}

export interface EnvironmentSummary {
  app: string;
  slug: string;
  version: string;
  platform: string;
  locale: string;
  screen: string;
  desktopShell: boolean;
}

export function environmentSummary(shell: boolean): EnvironmentSummary {
  return {
    app: APP_NAME,
    slug: APP_SLUG,
    version: APP_VERSION,
    platform: typeof navigator === "undefined" ? "unknown" : navigator.platform,
    locale: typeof navigator === "undefined" ? "unknown" : navigator.language,
    screen: typeof window === "undefined" ? "unknown" : `${window.innerWidth}x${window.innerHeight}`,
    desktopShell: shell,
  };
}

/** The report text the seller copies or saves; contains no shop data. */
export function diagnosticsReport(shell: boolean, now: Date = new Date()): string {
  const env = environmentSummary(shell);
  const lines = [
    `# ${env.app} diagnostics`,
    `generated: ${now.toISOString()}`,
    `version: ${env.version} (${env.slug})`,
    `platform: ${env.platform}`,
    `locale: ${env.locale}`,
    `window: ${env.screen}`,
    `desktop shell: ${env.desktopShell ? "yes" : "no"}`,
    "",
    "## recent events",
    ...(events.length === 0 ? ["(none)"] : events.map((e) => `${e.at} ${e.kind} ${e.name}${e.detail ? ` — ${e.detail}` : ""}`)),
  ];
  return lines.join("\n");
}
