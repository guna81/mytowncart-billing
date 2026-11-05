// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  ITEMS_CSV_HEADER,
  itemsToCsv,
  parseCsv,
  parseItemsCsv,
  serializeCsv,
} from "../src/csv";

describe("parseCsv", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });
  it("handles CRLF and missing trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
  it("handles quoted fields with commas, quotes and newlines", () => {
    expect(parseCsv('"a,b","say ""hi""","line1\nline2"')).toEqual([
      ["a,b", 'say "hi"', "line1\nline2"],
    ]);
  });
  it("skips blank lines but keeps empty fields", () => {
    expect(parseCsv("a,b\n\n1,\n,2\n")).toEqual([
      ["a", "b"],
      ["1", ""],
      ["", "2"],
    ]);
  });
  it("handles an empty file", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n\n")).toEqual([]);
  });
});

describe("serializeCsv", () => {
  it("quotes only when needed", () => {
    expect(serializeCsv([["a", "b,c", 'he said "hi"', null, undefined, 42]])).toBe(
      'a,"b,c","he said ""hi""",,,42\n',
    );
  });
  it("round-trips through parseCsv", () => {
    const rows = [
      ["plain", "with,comma", 'with "quotes"', "with\nnewline", ""],
      ["1", "2", "3", "4", "5"],
    ];
    expect(parseCsv(serializeCsv(rows))).toEqual(rows);
  });
});

describe("parseItemsCsv", () => {
  it("parses a headered file in canonical order", () => {
    const text = [
      ITEMS_CSV_HEADER.join(","),
      "Parle-G,8901234,Snacks,count,10.00,12.00,500,50",
      "Rice,,Grains,weight,55.50,60.00,0,25.5",
    ].join("\n");
    const { items, errors } = parseItemsCsv(text);
    expect(errors).toEqual([]);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      name: "Parle-G",
      barcode: "8901234",
      category: "Snacks",
      unitKind: "count",
      pricePaise: 1000,
      mrpPaise: 1200,
      taxRateBp: 500,
      openingStockMilli: 50_000,
    });
    expect(items[1]!.openingStockMilli).toBe(25_500);
  });

  it("maps header columns regardless of order", () => {
    const text = "price,name\n10.00,Soap\n";
    const { items, errors } = parseItemsCsv(text);
    expect(errors).toEqual([]);
    expect(items[0]!.name).toBe("Soap");
    expect(items[0]!.pricePaise).toBe(1000);
  });

  it("assumes canonical order without a header", () => {
    const { items, errors } = parseItemsCsv("Soap,123,,count,10,12,0,3\n");
    expect(errors).toEqual([]);
    expect(items[0]!.barcode).toBe("123");
  });

  it("reports per-row errors without failing the batch", () => {
    const text = [
      ITEMS_CSV_HEADER.join(","),
      "Good,1,,count,10,10,0,1",
      ",2,,count,10,10,0,1", // no name
      "Bad,3,,piece,10,10,0,1", // bad unit
      "Bad,4,,count,abc,10,0,1", // bad price
      "Bad,5,,count,10,-1,0,1", // bad mrp
      "Bad,6,,count,10,10,99999,1", // bad tax
      "Bad,7,,count,10,10,0,xyz", // bad stock
      "Also good,8,,weight,10,10,0,0.5",
    ].join("\n");
    const { items, errors } = parseItemsCsv(text);
    expect(items.map((i) => i.name)).toEqual(["Good", "Also good"]);
    expect(errors.map((e) => e.row)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(errors[0]!.message).toContain("name is required");
    expect(errors[1]!.message).toContain("unit_kind");
  });

  it("defaults: empty unit_kind is count, empty numerics are zero", () => {
    const { items, errors } = parseItemsCsv("name\nSoap\n");
    expect(errors).toEqual([]);
    expect(items[0]).toMatchObject({
      unitKind: "count",
      pricePaise: 0,
      mrpPaise: 0,
      taxRateBp: 0,
      openingStockMilli: 0,
    });
  });

  it("fails cleanly when the header lacks the name column", () => {
    const { items, errors } = parseItemsCsv("price,barcode\n10,123\n");
    expect(items).toEqual([]);
    expect(errors[0]!.message).toContain("'name'");
  });

  it("handles messy real-world input: quotes, commas, blank lines", () => {
    const text =
      'name,barcode,category,unit_kind,price,mrp,tax_rate_bp,opening_stock\n' +
      '"Oil, sunflower 1L",8901,"Grocery, Staples",volume,120.50,130,500,10\n' +
      "\n" +
      '"Quote ""Special""",8902,,count,5,5,0,2\n';
    const { items, errors } = parseItemsCsv(text);
    expect(errors).toEqual([]);
    expect(items[0]!.name).toBe("Oil, sunflower 1L");
    expect(items[0]!.category).toBe("Grocery, Staples");
    expect(items[1]!.name).toBe('Quote "Special"');
  });
});

describe("itemsToCsv", () => {
  it("exports the same columns the importer reads (round-trip)", () => {
    const csv = itemsToCsv([
      {
        name: "Parle-G",
        barcode: "8901",
        category: "Snacks",
        unitKind: "count",
        pricePaise: 1000,
        mrpPaise: 1200,
        taxRateBp: 500,
        stockMilli: 50_000,
      },
    ]);
    const { items, errors } = parseItemsCsv(csv);
    expect(errors).toEqual([]);
    expect(items[0]).toMatchObject({
      name: "Parle-G",
      pricePaise: 1000,
      openingStockMilli: 50_000,
    });
  });
});
