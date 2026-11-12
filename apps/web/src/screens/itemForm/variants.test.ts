// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { applyAxes, axesFromRows, baseNameOf, variantItemName, type VariantRow } from "./variants";

const row = (options: Record<string, string>, extra: Partial<VariantRow> = {}): VariantRow => ({
  options,
  price: "500",
  mrp: "600",
  cost: "",
  stock: "0",
  barcode: "",
  ...extra,
});

describe("variant helpers", () => {
  it("builds one row per combination from the first row's price", () => {
    const rows = applyAxes(
      [
        { name: "Size", values: ["S", "M"] },
        { name: "Colour", values: ["Red", "Blue"] },
      ],
      [row({})],
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.price === "500")).toBe(true);
  });

  it("keeps id, price and stock of unchanged combinations", () => {
    const rows = applyAxes(
      [{ name: "size", values: ["m", "L"] }],
      [row({ Size: "M" }, { id: 7, price: "450", stock: "3" })],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 7, price: "450", stock: "3" });
    expect(rows[1]?.id).toBeUndefined();
  });

  it("round-trips item names", () => {
    const options = { Size: "M", Colour: "Red" };
    const name = variantItemName("T-shirt", options);
    expect(name).toBe("T-shirt – M / Red");
    expect(baseNameOf(name, options)).toBe("T-shirt");
    expect(axesFromRows([row(options)])).toEqual([
      { name: "Size", values: ["M"] },
      { name: "Colour", values: ["Red"] },
    ]);
  });
});
