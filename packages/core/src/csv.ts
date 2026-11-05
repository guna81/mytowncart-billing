// SPDX-License-Identifier: Apache-2.0
/**
 * CSV parse/serialize (RFC-4180-ish) plus the items import/export mapping.
 * Parsing is tolerant: CRLF or LF, quoted fields with "" escapes, blank
 * lines skipped. Bad ITEM rows produce per-row errors, never a whole-file
 * failure (one bad row must not fail the batch, §B1).
 */

import { formatPaise, parsePaise } from "./money";
import { formatQty, parseQty, isUnitKind, type UnitKind } from "./quantity";

/** Parse CSV text into rows of string cells. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Trailing field/row (file not ending in newline).
  if (field !== "" || row.length > 0) pushRow();
  if (inQuotes) {
    // Unterminated quote: we still return what we have — item-level
    // validation decides whether the truncated row is usable.
  }
  return rows;
}

function escapeField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Serialize rows to CSV text (LF line endings, minimal quoting). */
export function serializeCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return rows
    .map((row) => row.map((cell) => escapeField(cell == null ? "" : String(cell))).join(","))
    .join("\n") + "\n";
}

/** Canonical items CSV header (also the export order). */
export const ITEMS_CSV_HEADER = [
  "name",
  "barcode",
  "category",
  "unit_kind",
  "price",
  "mrp",
  "tax_rate_bp",
  "opening_stock",
] as const;

export interface ItemDraft {
  name: string;
  barcode: string;
  /** Category NAME (resolved to an id by the storage layer; empty = none). */
  category: string;
  unitKind: UnitKind;
  pricePaise: number;
  mrpPaise: number;
  taxRateBp: number;
  /** Opening stock in milli-units (only applied to newly created items). */
  openingStockMilli: number;
}

export interface CsvRowError {
  /** 1-based line number in the original file (header = line 1). */
  row: number;
  message: string;
}

export interface ItemsCsvParseResult {
  items: ItemDraft[];
  errors: CsvRowError[];
}

/**
 * Parse an items CSV. A header row matching ITEMS_CSV_HEADER names (case-,
 * space-insensitive, order-free) is detected and used to map columns;
 * without a header the canonical order is assumed.
 */
export function parseItemsCsv(text: string): ItemsCsvParseResult {
  const rows = parseCsv(text);
  const items: ItemDraft[] = [];
  const errors: CsvRowError[] = [];
  if (rows.length === 0) return { items, errors };

  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "_");
  const first = rows[0]!.map(normalize);
  const canonical = new Set<string>(ITEMS_CSV_HEADER);
  const hasHeader = first.some((c) => canonical.has(c));
  const colIndex = new Map<string, number>();
  let dataStart = 0;
  if (hasHeader) {
    first.forEach((c, idx) => {
      if (canonical.has(c)) colIndex.set(c, idx);
    });
    if (!colIndex.has("name")) {
      errors.push({ row: 1, message: "header is missing the required 'name' column" });
      return { items, errors };
    }
    dataStart = 1;
  } else {
    ITEMS_CSV_HEADER.forEach((c, idx) => colIndex.set(c, idx));
  }

  const cell = (row: string[], col: string): string => {
    const idx = colIndex.get(col);
    return idx === undefined ? "" : (row[idx] ?? "").trim();
  };

  for (let r = dataStart; r < rows.length; r += 1) {
    const row = rows[r]!;
    const lineNo = r + 1;
    const name = cell(row, "name");
    if (name === "") {
      errors.push({ row: lineNo, message: "name is required" });
      continue;
    }
    const unitRaw = cell(row, "unit_kind") || "count";
    if (!isUnitKind(unitRaw)) {
      errors.push({ row: lineNo, message: `unit_kind must be count|weight|volume, got "${unitRaw}"` });
      continue;
    }
    const pricePaise = parsePaise(cell(row, "price") || "0");
    if (pricePaise === null || pricePaise < 0) {
      errors.push({ row: lineNo, message: `bad price "${cell(row, "price")}"` });
      continue;
    }
    const mrpPaise = parsePaise(cell(row, "mrp") || "0");
    if (mrpPaise === null || mrpPaise < 0) {
      errors.push({ row: lineNo, message: `bad mrp "${cell(row, "mrp")}"` });
      continue;
    }
    const taxRaw = cell(row, "tax_rate_bp") || "0";
    const taxRateBp = /^\d+$/.test(taxRaw) ? Number(taxRaw) : NaN;
    if (!Number.isSafeInteger(taxRateBp) || taxRateBp < 0 || taxRateBp > 10_000) {
      errors.push({ row: lineNo, message: `bad tax_rate_bp "${taxRaw}" (0–10000)` });
      continue;
    }
    const stockRaw = cell(row, "opening_stock") || "0";
    const openingStockMilli = parseQty(stockRaw);
    if (openingStockMilli === null) {
      errors.push({ row: lineNo, message: `bad opening_stock "${stockRaw}"` });
      continue;
    }
    items.push({
      name,
      barcode: cell(row, "barcode"),
      category: cell(row, "category"),
      unitKind: unitRaw,
      pricePaise,
      mrpPaise,
      taxRateBp,
      openingStockMilli,
    });
  }
  return { items, errors };
}

export interface ItemExportRow {
  name: string;
  barcode: string;
  category: string;
  unitKind: UnitKind;
  pricePaise: number;
  mrpPaise: number;
  taxRateBp: number;
  stockMilli: number;
}

/** Serialize items for export (same columns as the import format). */
export function itemsToCsv(items: readonly ItemExportRow[]): string {
  const rows: (string | number)[][] = [[...ITEMS_CSV_HEADER]];
  for (const it of items) {
    rows.push([
      it.name,
      it.barcode,
      it.category,
      it.unitKind,
      formatPaise(it.pricePaise),
      formatPaise(it.mrpPaise),
      it.taxRateBp,
      formatQty(it.stockMilli),
    ]);
  }
  return serializeCsv(rows);
}
