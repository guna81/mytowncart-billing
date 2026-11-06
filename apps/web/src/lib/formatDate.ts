// SPDX-License-Identifier: Apache-2.0

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function toValidDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return null;
  return date;
}

/**
 * Formats a date into a clean, unambiguous string (e.g. "6 Nov 2026").
 */
export function formatDate(value: string | number | Date | null | undefined, fallback = "—"): string {
  const d = toValidDate(value);
  if (!d) return fallback;
  return dateFormatter.format(d);
}

/**
 * Formats a date with time (e.g. "6 Nov 2026, 15:53:48").
 */
export function formatDateTime(value: string | number | Date | null | undefined, fallback = "—"): string {
  const d = toValidDate(value);
  if (!d) return fallback;
  return dateTimeFormatter.format(d);
}

/**
 * Formats time only (e.g. "15:53:48").
 */
export function formatTime(value: string | number | Date | null | undefined, fallback = "—"): string {
  const d = toValidDate(value);
  if (!d) return fallback;
  return timeFormatter.format(d);
}

/**
 * Formats a date range (e.g. "6 Nov 2026 → 7 Nov 2026").
 */
export function formatDateRange(
  start: string | number | Date | null | undefined,
  end: string | number | Date | null | undefined,
  fallback = "—",
): string {
  const s = formatDate(start, fallback);
  const e = formatDate(end, fallback);
  if (s === fallback && e === fallback) return fallback;
  return `${s} → ${e}`;
}
