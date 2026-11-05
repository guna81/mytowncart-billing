// SPDX-License-Identifier: Apache-2.0
/**
 * Invoice numbering (roadmap §8.2): sequential per Indian financial year
 * (April–March), gap-free. Core owns the FY computation and the number
 * FORMAT; the atomic allocation of the next sequence number happens in the
 * storage layer inside the same transaction that saves the bill.
 *
 * FORMAT RULE (must stay byte-identical to the Rust shell's formatter in
 * `apps/desktop/src-tauri/src/repo.rs::format_invoice_number`):
 *   number = prefix + String(seq).padStart(4, "0")   e.g. "INV-0042"
 * Sequences beyond 9999 are not truncated ("INV-10000").
 */

/** FY label for an ISO calendar date ("2026-03-31" -> "2025-26", "2026-04-01" -> "2026-27"). */
export function financialYearFor(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) throw new Error(`expected an ISO date (YYYY-MM-DD), got "${isoDate}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`bad month in "${isoDate}"`);
  const startYear = month >= 4 ? year : year - 1;
  return fyLabel(startYear);
}

/** "2026" -> "2026-27". */
export function fyLabel(startYear: number): string {
  const endShort = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endShort}`;
}

/** First calendar day of an FY ("2026-27" -> "2026-04-01"). */
export function fyStartDate(fy: string): string {
  const m = /^(\d{4})-\d{2}$/.exec(fy);
  if (!m) throw new Error(`bad FY label "${fy}"`);
  return `${m[1]}-04-01`;
}

/** Last calendar day of an FY ("2026-27" -> "2027-03-31"). */
export function fyEndDate(fy: string): string {
  const m = /^(\d{4})-\d{2}$/.exec(fy);
  if (!m) throw new Error(`bad FY label "${fy}"`);
  return `${Number(m[1]) + 1}-03-31`;
}

/** prefix + zero-padded sequence (min width 4). See the format rule above. */
export function formatInvoiceNumber(prefix: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error(`invoice sequence must be a positive integer, got ${seq}`);
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

/** Today's ISO calendar date (local time), for FY computation at bill time. */
export function isoDateOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Local-time ISO 8601 stamp WITH offset ("2026-11-05T01:30:00+05:30").
 * Stored timestamps use this instead of `toISOString()`: reports slice the
 * first 10 chars off the stored string, so a UTC stamp would file a late
 * evening sale under the wrong day east of Greenwich.
 */
export function localIsoTimestamp(date: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${isoDateOf(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${String(date.getMilliseconds()).padStart(3, "0")}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}
