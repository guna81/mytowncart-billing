// SPDX-License-Identifier: Apache-2.0
/**
 * GST tax computation (roadmap §8.2: per-item `tax_rate_bp`, shop-level
 * `prices_include_tax`, CGST/SGST split).
 *
 * ROUNDING RULE (recorded in DECISIONS.md, entry B1-1):
 *   All tax and line-total math is integer paise via `roundDiv` —
 *   "round half away from zero to the nearest paise" — applied at the
 *   BILL-LINE level. Bill-level tax/subtotal/total are plain sums of the
 *   rounded line amounts, so a bill's displayed total always equals the
 *   sum of its displayed lines (no reconciliation paise appear later).
 *   The CGST/SGST split of a line's tax is `cgst = roundDiv(tax, 2)` and
 *   `sgst = tax - cgst`, so CGST + SGST always equals the line tax exactly.
 */

import { mulBps, mulQtyMilli, roundDiv } from "./money";

export interface LineTaxInput {
  qtyMilli: number;
  /** Customer-facing unit price: NET of tax when `pricesIncludeTax` is false, tax-INCLUSIVE when true. */
  unitPricePaise: number;
  /** GST rate in basis points (5% = 500, 18% = 1800). 0 = untaxed. */
  taxRateBp: number;
  pricesIncludeTax: boolean;
}

export interface LineAmounts {
  /** Line amount net of tax. */
  netPaise: number;
  /** Total GST on the line. */
  taxPaise: number;
  /** What the customer pays for the line (net + tax). */
  totalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

export function splitGst(taxPaise: number): { cgstPaise: number; sgstPaise: number } {
  const cgstPaise = roundDiv(taxPaise, 2);
  return { cgstPaise, sgstPaise: taxPaise - cgstPaise };
}

export function computeLineAmounts(input: LineTaxInput): LineAmounts {
  const { qtyMilli, unitPricePaise, taxRateBp, pricesIncludeTax } = input;
  if (taxRateBp < 0) throw new Error("taxRateBp must be >= 0");
  let netPaise: number;
  let taxPaise: number;
  let totalPaise: number;
  if (pricesIncludeTax) {
    // Unit price already contains tax: back the tax out of the gross.
    totalPaise = mulQtyMilli(unitPricePaise, qtyMilli);
    taxPaise = taxRateBp === 0 ? 0 : roundDiv(totalPaise * taxRateBp, 10_000 + taxRateBp);
    netPaise = totalPaise - taxPaise;
  } else {
    netPaise = mulQtyMilli(unitPricePaise, qtyMilli);
    taxPaise = mulBps(netPaise, taxRateBp);
    totalPaise = netPaise + taxPaise;
  }
  const { cgstPaise, sgstPaise } = splitGst(taxPaise);
  return { netPaise, taxPaise, totalPaise, cgstPaise, sgstPaise };
}
