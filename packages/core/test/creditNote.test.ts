// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { computeCreditNote } from "../src/creditNote";

describe("computeCreditNote", () => {
  it("computes credit note lines and totals correctly", () => {
    const cn = computeCreditNote(
      1,
      "Damaged package",
      [
        {
          itemId: 10,
          name: "Biscuits",
          qtyMilli: 2000,
          unitPricePaise: 2500,
          taxRateBp: 500,
          hsnCode: "1905",
        },
      ],
      { pricesIncludeTax: true },
    );

    expect(cn.billId).toBe(1);
    expect(cn.reason).toBe("Damaged package");
    expect(cn.lines).toHaveLength(1);
    expect(cn.totalPaise).toBe(5000);
    expect(cn.subtotalPaise + cn.taxPaise).toBe(5000);
    expect(cn.lines[0]?.hsnCode).toBe("1905");
  });

  it("throws when lines are empty or reason is missing", () => {
    expect(() =>
      computeCreditNote(1, "Reason", [], { pricesIncludeTax: true }),
    ).toThrow("at least one line");

    expect(() =>
      computeCreditNote(
        1,
        "   ",
        [
          {
            itemId: 10,
            name: "Item",
            qtyMilli: 1000,
            unitPricePaise: 1000,
            taxRateBp: 0,
          },
        ],
        { pricesIncludeTax: true },
      ),
    ).toThrow("reason is required");
  });
});
