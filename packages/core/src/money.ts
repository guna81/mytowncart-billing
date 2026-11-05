// SPDX-License-Identifier: Apache-2.0
/**
 * Money — integer paise everywhere (roadmap §8.2).
 *
 * No floats ever hold a money value. A float may appear transiently inside
 * `formatPaise`/`parsePaise` conversions, never in storage or computation.
 * All rounding uses {@link roundDiv} — see the documented rounding rule in
 * `tax.ts`.
 */

/** Asserts (in dev terms, via throwing) that a value is a safe integer. */
export function assertSafeInteger(value: number, label = "value"): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer, got ${value}`);
  }
  return value;
}

export function addPaise(...values: number[]): number {
  let sum = 0;
  for (const v of values) {
    assertSafeInteger(v, "addend");
    sum += v;
  }
  return assertSafeInteger(sum, "sum");
}

export function subPaise(a: number, b: number): number {
  return addPaise(a, -b);
}

/**
 * Round `numerator / denominator` to the nearest integer, halves away from
 * zero. Denominator must be a positive integer. This is THE rounding rule
 * for the whole app (documented in DECISIONS.md, entry B1-1): round half
 * away from zero, applied at the bill-line level, never via floats.
 */
export function roundDiv(numerator: number, denominator: number): number {
  assertSafeInteger(numerator, "numerator");
  assertSafeInteger(denominator, "denominator");
  if (denominator <= 0) throw new Error("denominator must be positive");
  const negative = numerator < 0;
  const n = Math.abs(numerator);
  const q = Math.floor(n / denominator);
  const r = n - q * denominator;
  const rounded = r * 2 >= denominator ? q + 1 : q;
  return negative ? -rounded : rounded;
}

/** Multiply a paise amount by basis points (1% = 100 bp): paise * bp / 10000. */
export function mulBps(paise: number, basisPoints: number): number {
  assertSafeInteger(paise, "paise");
  assertSafeInteger(basisPoints, "basisPoints");
  return roundDiv(paise * basisPoints, 10_000);
}

/** Multiply a unit price in paise by a quantity in thousandths (qty_milli). */
export function mulQtyMilli(unitPaise: number, qtyMilli: number): number {
  assertSafeInteger(unitPaise, "unitPaise");
  assertSafeInteger(qtyMilli, "qtyMilli");
  return roundDiv(unitPaise * qtyMilli, 1_000);
}

/**
 * Split `total` into `weights.length` integer parts proportional to the
 * weights, summing EXACTLY to `total` (largest-remainder method; ties break
 * toward the earlier index). Used e.g. to spread a bill-level discount.
 */
export function allocatePaise(total: number, weights: number[]): number[] {
  assertSafeInteger(total, "total");
  if (weights.length === 0) {
    if (total !== 0) throw new Error("cannot allocate a non-zero total to zero shares");
    return [];
  }
  const weightSum = weights.reduce((s, w) => {
    assertSafeInteger(w, "weight");
    if (w < 0) throw new Error("weights must be >= 0");
    return s + w;
  }, 0);
  if (weightSum <= 0) throw new Error("at least one weight must be positive");

  const shares = weights.map((w) => Math.floor((total * w) / weightSum));
  let remainder = total - shares.reduce((s, v) => s + v, 0);
  // Fractional parts in units of 1/weightSum; distribute one paise at a time
  // to the largest remainders. `remainder` can be negative for negative totals.
  const fractions = weights.map((w, i) => ({
    i,
    frac: total * w - shares[i]! * weightSum,
  }));
  fractions.sort((a, b) => (remainder >= 0 ? b.frac - a.frac : a.frac - b.frac) || a.i - b.i);
  const step = remainder >= 0 ? 1 : -1;
  for (let k = 0; k < fractions.length && remainder !== 0; k += 1) {
    shares[fractions[k]!.i]! += step;
    remainder -= step;
  }
  return shares;
}

/** Format integer paise as a 2-dp decimal string: 1234 -> "12.34", -50 -> "-0.50". */
export function formatPaise(paise: number): string {
  assertSafeInteger(paise, "paise");
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Parse a decimal string ("12", "12.3", "12.34", "-0.50", "1,234.56" not
 * supported — commas are NOT stripped) into integer paise. Returns null on
 * any malformed input or more than 2 decimal places.
 */
export function parsePaise(text: string): number | null {
  const trimmed = text.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!m) return null;
  const whole = Number(m[2]);
  const frac = m[3] === undefined ? 0 : Number(m[3].padEnd(2, "0"));
  if (!Number.isSafeInteger(whole)) return null;
  const paise = whole * 100 + frac;
  return m[1] === "-" ? -paise : paise;
}
