// SPDX-License-Identifier: Apache-2.0
/** Pure helpers for the item form's "sizes & options" feature. */

/** One option (e.g. Size) and the values offered for it (S, M, L). */
export type OptionAxis = { name: string; values: string[] };

/** One sellable row: a single combination of option values. */
export type VariantRow = {
  /** Present for rows that already exist as items. */
  id?: number;
  options: Record<string, string>;
  price: string;
  mrp: string;
  /** Cost price per unit; blank = use the shared cost price. */
  cost: string;
  /** Opening stock for new rows; shown read-only for existing ones. */
  stock: string;
  barcode: string;
};

const norm = (s: string) => s.trim().toLowerCase();

export function dedupeValues(vals: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of vals) {
    const v = raw.trim();
    if (v && !seen.has(norm(v))) {
      seen.add(norm(v));
      out.push(v);
    }
  }
  return out;
}

export function axesFromRows(rows: VariantRow[]): OptionAxis[] {
  const axes: OptionAxis[] = [];
  for (const r of rows) {
    for (const [name, value] of Object.entries(r.options)) {
      if (!name.trim() || !value.trim()) continue;
      let axis = axes.find((a) => norm(a.name) === norm(name));
      if (!axis) axes.push((axis = { name: name.trim(), values: [] }));
      axis.values = dedupeValues([...axis.values, value]);
    }
  }
  return axes;
}

function cartesian(axes: OptionAxis[]): Record<string, string>[] {
  return axes.reduce<Record<string, string>[]>(
    (acc, axis) => acc.flatMap((combo) => axis.values.map((v) => ({ ...combo, [axis.name]: v }))),
    [{}],
  );
}

const sameOptions = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length &&
    ka.every((k) => Object.keys(b).some((kb) => norm(kb) === norm(k) && norm(b[kb] ?? "") === norm(a[k] ?? "")))
  );
};

/**
 * Rebuild the rows from option axes. A row whose combination is unchanged keeps
 * its id, price and stock; new ones start from the first row's price.
 */
export function applyAxes(axes: OptionAxis[], rows: VariantRow[]): VariantRow[] {
  const clean = axes
    .map((a) => ({ name: a.name.trim(), values: dedupeValues(a.values) }))
    .filter((a) => a.name && a.values.length);
  if (clean.length === 0) return rows;
  const base = rows[0];
  return cartesian(clean).map((options) => {
    const existing = rows.find((r) => sameOptions(r.options, options));
    return existing
      ? { ...existing, options }
      : { options, price: base?.price ?? "", mrp: base?.mrp ?? "", cost: base?.cost ?? "", stock: "0", barcode: "" };
  });
}

const SEP = " – ";

/** "T-shirt – M / Red": how each variant appears on the bill and in lists. */
export function variantItemName(base: string, options: Record<string, string>): string {
  const label = Object.values(options)
    .map((v) => v.trim())
    .filter(Boolean)
    .join(" / ");
  return label ? `${base.trim()}${SEP}${label}` : base.trim();
}

/** Recover the product name from a variant item's stored name. */
export function baseNameOf(name: string, options: Record<string, string>): string {
  const full = variantItemName("", options); // " – M / Red" shape without base
  const suffix = full.startsWith(SEP) ? full : "";
  return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

export function newVariantGroup(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `grp_${rand}`;
}
