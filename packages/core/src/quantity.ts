// SPDX-License-Identifier: Apache-2.0
/**
 * Quantity — integer thousandths (`qty_milli`, roadmap §8.2) so kg/litre
 * items work without floats. 1000 milli = 1 unit.
 */

export type UnitKind = "count" | "weight" | "volume";

export const UNIT_KINDS: readonly UnitKind[] = ["count", "weight", "volume"];

/** 1 whole unit in milli-units. */
export const QTY_UNIT = 1_000;

export function isUnitKind(value: string): value is UnitKind {
  return (UNIT_KINDS as readonly string[]).includes(value);
}

/** True when the quantity is a whole number of units (required for `count` items). */
export function isWholeCount(qtyMilli: number): boolean {
  return Number.isSafeInteger(qtyMilli) && qtyMilli % QTY_UNIT === 0;
}

/**
 * Format milli-quantity with up to 3 decimals, trailing zeros stripped:
 * 1000 -> "1", 1500 -> "1.5", 1250 -> "1.25", 250 -> "0.25".
 */
export function formatQty(qtyMilli: number): string {
  if (!Number.isSafeInteger(qtyMilli)) throw new Error(`qty must be a safe integer, got ${qtyMilli}`);
  const negative = qtyMilli < 0;
  const abs = Math.abs(qtyMilli);
  const whole = Math.floor(abs / QTY_UNIT);
  const fracMilli = abs % QTY_UNIT;
  if (fracMilli === 0) return `${negative ? "-" : ""}${whole}`;
  const frac = String(fracMilli).padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Parse a quantity string ("2", "1.5", "0.250") into milli-units.
 * At most 3 decimal places. Returns null on malformed input.
 */
export function parseQty(text: string): number | null {
  const trimmed = text.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (!m) return null;
  const whole = Number(m[2]);
  const frac = m[3] === undefined ? 0 : Number(m[3].padEnd(3, "0"));
  if (!Number.isSafeInteger(whole)) return null;
  const milli = whole * QTY_UNIT + frac;
  return m[1] === "-" ? -milli : milli;
}
