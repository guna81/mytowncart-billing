// SPDX-License-Identifier: Apache-2.0
import { computeLineAmounts, type LineAmounts } from "./tax";

export interface CreditNoteLineInput {
  itemId: number;
  name: string;
  qtyMilli: number;
  unitPricePaise: number;
  taxRateBp: number;
  hsnCode?: string;
}

export interface ComputedCreditNoteLine extends LineAmounts {
  itemId: number;
  name: string;
  qtyMilli: number;
  unitPricePaise: number;
  taxRateBp: number;
  hsnCode: string;
}

export interface ComputedCreditNote {
  billId: number;
  reason: string;
  lines: ComputedCreditNoteLine[];
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
}

export function computeCreditNote(
  billId: number,
  reason: string,
  lines: readonly CreditNoteLineInput[],
  options: { pricesIncludeTax: boolean },
): ComputedCreditNote {
  if (lines.length === 0) {
    throw new Error("credit note must contain at least one line");
  }
  if (!reason.trim()) {
    throw new Error("credit note reason is required");
  }

  let subtotal = 0;
  let tax = 0;
  let total = 0;

  const computedLines: ComputedCreditNoteLine[] = lines.map((line) => {
    if (line.qtyMilli <= 0) {
      throw new Error(`quantity must be positive, got ${line.qtyMilli}`);
    }
    const amounts = computeLineAmounts({
      unitPricePaise: line.unitPricePaise,
      qtyMilli: line.qtyMilli,
      taxRateBp: line.taxRateBp,
      pricesIncludeTax: options.pricesIncludeTax,
      discountPaise: 0,
    });
    subtotal += amounts.netPaise;
    tax += amounts.taxPaise;
    total += amounts.totalPaise;
    return {
      ...amounts,
      itemId: line.itemId,
      name: line.name,
      qtyMilli: line.qtyMilli,
      unitPricePaise: line.unitPricePaise,
      taxRateBp: line.taxRateBp,
      hsnCode: line.hsnCode || "",
    };
  });

  return {
    billId,
    reason: reason.trim(),
    lines: computedLines,
    subtotalPaise: subtotal,
    taxPaise: tax,
    totalPaise: total,
  };
}
