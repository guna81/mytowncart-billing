// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  adjustmentMovement,
  applyMovements,
  isLowStock,
  openingStockMovement,
  saleMovements,
  voidCompensationMovements,
} from "../src/stock";

describe("movement descriptors", () => {
  it("opening stock: null for zero, movement otherwise", () => {
    expect(openingStockMovement(1, 0)).toBeNull();
    expect(openingStockMovement(1, 5000)).toEqual({
      itemId: 1,
      deltaMilli: 5000,
      reason: "opening",
      refType: null,
      refId: null,
    });
  });

  it("sale movements are negative deltas referenced to a bill", () => {
    const moves = saleMovements([
      { itemId: 1, qtyMilli: 2000 },
      { itemId: 2, qtyMilli: 500 },
    ]);
    expect(moves).toEqual([
      { itemId: 1, deltaMilli: -2000, reason: "sale", refType: "bill", refId: null },
      { itemId: 2, deltaMilli: -500, reason: "sale", refType: "bill", refId: null },
    ]);
  });

  it("void compensation exactly inverts the sale", () => {
    const lines = [
      { itemId: 1, qtyMilli: 2000 },
      { itemId: 2, qtyMilli: 500 },
    ];
    const sale = saleMovements(lines);
    const back = voidCompensationMovements(lines);
    for (let i = 0; i < sale.length; i += 1) {
      expect(back[i]!.deltaMilli).toBe(-sale[i]!.deltaMilli);
      expect(back[i]!.reason).toBe("void");
    }
  });

  it("adjustments must change the stock", () => {
    expect(() => adjustmentMovement(1, 0)).toThrow();
    expect(adjustmentMovement(1, -250, "adjustment").deltaMilli).toBe(-250);
    expect(adjustmentMovement(1, 10_000, "purchase").reason).toBe("purchase");
  });
});

describe("applyMovements", () => {
  it("folds deltas onto an initial level", () => {
    expect(applyMovements(0, [5000, -2000, -500, 1000])).toBe(3500);
    expect(applyMovements(100, [])).toBe(100);
    expect(applyMovements(0, [-1000])).toBe(-1000); // ledger allows negative (oversold)
  });

  it("a sale followed by its void nets to zero change", () => {
    const lines = [{ itemId: 1, qtyMilli: 2500 }];
    const deltas = [...saleMovements(lines), ...voidCompensationMovements(lines)].map(
      (m) => m.deltaMilli,
    );
    expect(applyMovements(10_000, deltas)).toBe(10_000);
  });
});

describe("isLowStock", () => {
  it("is at-or-below the threshold", () => {
    expect(isLowStock(0, 0)).toBe(true);
    expect(isLowStock(1000, 5000)).toBe(true);
    expect(isLowStock(5000, 5000)).toBe(true);
    expect(isLowStock(6000, 5000)).toBe(false);
    expect(isLowStock(1000, 0)).toBe(false);
  });
});
