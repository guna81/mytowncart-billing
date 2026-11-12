// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";

import { t } from "../../i18n";
import { applyAxes, axesFromRows, dedupeValues, type OptionAxis, type VariantRow } from "./variants";

const inputCls =
  "w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
/** Each extra option multiplies the rows, so keep the total sensible. */
const MAX_COMBOS = 100;
const CLOTHING = ["S", "M", "L", "XL", "XXL"];
const SHOES = ["6", "7", "8", "9", "10", "11"];
const COLOURS = ["Black", "White", "Red", "Blue", "Green", "Grey"];

const isName = (a: OptionAxis, n: string) => a.name.trim().toLowerCase() === n.toLowerCase() || (n === "Colour" && a.name.trim().toLowerCase() === "color");

const ROW_COLS = "md:grid-cols-[1.2fr_1fr_1fr_1fr_1fr_1.4fr_4.5rem]";

/** Label shown above a field on phones; on desktop the column header does that job. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-gray-600 md:sr-only">{label}</span>
      {children}
    </label>
  );
}

function Chip({ label, on, onClick }: { label: string; on?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-sm ${
        on ? "border-blue-600 bg-blue-600 font-semibold text-white" : "border-gray-300 text-gray-800 hover:bg-gray-50"
      }`}
    >
      {label}
    </button>
  );
}

/** Order values the way a shop expects: S, M, L, XL… then 6, 7, 8…; anything typed keeps its order at the end. */
function sortValues(values: string[]): string[] {
  const known = [...CLOTHING, ...SHOES, ...COLOURS];
  const rank = (v: string) => {
    const i = known.findIndex((k) => k.toLowerCase() === v.toLowerCase());
    return i === -1 ? known.length : i;
  };
  return values.map((v, i) => ({ v, i })).sort((x, y) => rank(x.v) - rank(y.v) || x.i - y.i).map((x) => x.v);
}

/**
 * One section per option. Size and Colour are separate, fixed sections, so values
 * from one can never end up in the other. Fill in only the ones the product has.
 */
function Builder({
  initial,
  onApply,
  onCancel,
}: {
  initial: OptionAxis[];
  onApply: (axes: OptionAxis[]) => void;
  onCancel: () => void;
}) {
  const [axes, setAxes] = useState<OptionAxis[]>(() => {
    const size = initial.find((a) => isName(a, "Size"));
    const colour = initial.find((a) => isName(a, "Colour"));
    const others = initial.filter((a) => a !== size && a !== colour);
    return [
      { name: "Size", values: size?.values ?? [] },
      { name: "Colour", values: colour?.values ?? [] },
      ...others,
    ];
  });
  const [shoes, setShoes] = useState(() => (initial.find((a) => isName(a, "Size"))?.values ?? []).some((v) => SHOES.includes(v)));
  const [drafts, setDrafts] = useState<string[]>(() => axes.map(() => ""));
  const patch = (i: number, p: Partial<OptionAxis>) => setAxes((a) => a.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const has = (a: OptionAxis, v: string) => a.values.some((x) => x.toLowerCase() === v.toLowerCase());
  const toggle = (i: number, v: string) => {
    const axis = axes[i];
    if (!axis) return;
    patch(i, { values: has(axis, v) ? axis.values.filter((x) => x.toLowerCase() !== v.toLowerCase()) : [...axis.values, v] });
  };
  const addDraft = (i: number) => {
    const axis = axes[i];
    if (!axis) return;
    patch(i, { values: dedupeValues([...axis.values, ...(drafts[i] ?? "").split(",")]) });
    setDrafts((d) => d.map((x, j) => (j === i ? "" : x)));
  };
  const switchSizeSet = (toShoes: boolean) => {
    // Clothing sizes and shoe sizes never mix: switching clears the other set.
    setShoes(toShoes);
    setAxes((a) =>
      a.map((x) => (isName(x, "Size") ? { ...x, values: x.values.filter((v) => !(toShoes ? CLOTHING : SHOES).includes(v)) } : x)),
    );
  };
  const usable = axes.filter((a) => a.name.trim() && a.values.length);
  const total = usable.reduce((n, a) => n * a.values.length, 1);
  const tooMany = total > MAX_COMBOS;

  return (
    <div className="space-y-4" data-testid="variant-builder">
      <div>
        <h2 className="text-base font-bold text-gray-900">{t("item_form.variants.pick_title")}</h2>
        <p className="text-xs text-gray-600">{t("item_form.variants.values_hint")}</p>
      </div>
      {axes.map((a, i) => {
        const size = isName(a, "Size");
        const colour = isName(a, "Colour");
        const quick = size ? (shoes ? SHOES : CLOTHING) : colour ? COLOURS : [];
        const custom = a.values.filter((v) => !quick.some((q) => q.toLowerCase() === v.toLowerCase()));
        return (
          <div key={i} className="space-y-2 rounded-lg border border-gray-200 p-3">
            <div className="flex flex-wrap items-center gap-3">
              {size || colour ? (
                <h3 className="text-sm font-bold text-gray-900">{size ? t("item_form.variants.axis_size") : t("item_form.variants.axis_colour")}</h3>
              ) : (
                <input
                  className={`${inputCls} max-w-[12rem]`}
                  placeholder={t("item_form.variants.option_name")}
                  value={a.name}
                  autoFocus
                  onChange={(e) => patch(i, { name: e.target.value })}
                />
              )}
              {size ? (
                <div className="flex gap-1" role="group" aria-label={t("item_form.variants.size_type")}>
                  <Chip label={t("item_form.variants.size_clothing")} on={!shoes} onClick={() => switchSizeSet(false)} />
                  <Chip label={t("item_form.variants.size_shoes")} on={shoes} onClick={() => switchSizeSet(true)} />
                </div>
              ) : null}
              {!size && !colour ? (
                <button
                  type="button"
                  className="ml-auto text-sm text-red-600 hover:underline"
                  onClick={() => {
                    setAxes((x) => x.filter((_, j) => j !== i));
                    setDrafts((d) => d.filter((_, j) => j !== i));
                  }}
                >
                  {t("item_form.variants.remove")}
                </button>
              ) : null}
            </div>
            {quick.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {quick.map((v) => (
                  <Chip key={v} label={v} on={has(a, v)} onClick={() => toggle(i, v)} />
                ))}
              </div>
            ) : null}
            {custom.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {quick.length > 0 ? <span className="text-xs text-gray-600">{t("item_form.variants.yours")}</span> : null}
                {custom.map((v) => (
                  <Chip key={v} label={`${v}  ✕`} on onClick={() => toggle(i, v)} />
                ))}
              </div>
            ) : null}
            <div className="flex gap-2">
              <input
                className={inputCls}
                placeholder={t("item_form.variants.type_value")}
                value={drafts[i] ?? ""}
                onChange={(e) => setDrafts((d) => d.map((x, j) => (j === i ? e.target.value : x)))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addDraft(i);
                  }
                }}
              />
              <button type="button" className="rounded-lg border border-gray-300 px-3 text-sm font-semibold" onClick={() => addDraft(i)}>
                {t("item_form.variants.add_value")}
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        className="text-sm font-semibold text-blue-700 hover:underline"
        onClick={() => {
          setAxes((a) => [...a, { name: "", values: [] }]);
          setDrafts((d) => [...d, ""]);
        }}
      >
        + {t("item_form.variants.add_option")}
      </button>
      <div className="flex items-center justify-end gap-2">
        {usable.length === 0 ? <span className="mr-auto text-xs text-gray-600">{t("item_form.variants.pick_one")}</span> : null}
        {tooMany ? <span className="mr-auto text-xs text-red-600">{t("item_form.variants.too_many", { count: total })}</span> : null}
        <button type="button" className="rounded-lg border border-gray-300 px-4 py-2 text-sm" onClick={onCancel}>
          {t("item_form.variants.cancel")}
        </button>
        <button
          type="button"
          data-testid="variant-apply"
          disabled={usable.length === 0 || tooMany}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          onClick={() => onApply(axes.map((a) => ({ ...a, values: sortValues(a.values) })))}
        >
          {t("item_form.variants.create", { count: total })}
        </button>
      </div>
    </div>
  );
}

/**
 * "Sizes & options" card: a link in the default single-item form, a builder to
 * pick options, and one row per combination (price, MRP, stock, barcode).
 */
export function VariantEditor({
  rows,
  setRows,
  canStart,
  sellPrice,
  sellMrp,
  sellCost,
  plainItem,
}: {
  rows: VariantRow[];
  setRows: (rows: VariantRow[]) => void;
  /** False when editing a plain existing item (it cannot be turned into a group here). */
  canStart: boolean;
  sellPrice: string;
  sellMrp: string;
  sellCost: string;
  /** Editing a plain item: it becomes the first option, keeping its id, stock and history. */
  plainItem: { id: number; stock: string; barcode: string } | null;
}) {
  const [building, setBuilding] = useState(false);
  const multi = rows.length > 1;
  if (!multi && !building && !canStart) return null;

  const update = (i: number, p: Partial<VariantRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const start = (axes: OptionAxis[]) => {
    const seed: VariantRow[] = rows.length
      ? rows
      : [{
          ...(plainItem ? { id: plainItem.id } : {}),
          options: {}, price: sellPrice, mrp: sellMrp, cost: sellCost,
          stock: plainItem?.stock ?? "0", barcode: plainItem?.barcode ?? "",
        }];
    const next = applyAxes(axes, seed);
    // The original item takes over the first combination rather than being left behind.
    if (plainItem && next.length > 0 && !next.some((r) => r.id === plainItem.id)) {
      next[0] = { ...next[0]!, id: plainItem.id, stock: plainItem.stock, barcode: plainItem.barcode };
    }
    setRows(next);
    setBuilding(false);
  };

  return (
    <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-6 shadow-xs" data-testid="variant-editor">
      {building ? (
        <Builder initial={axesFromRows(rows)} onApply={start} onCancel={() => setBuilding(false)} />
      ) : multi ? (
        <>
          <div className="flex items-start justify-between border-b border-gray-100 pb-2.5">
            <div>
              <h2 className="text-base font-bold text-gray-900">{t("item_form.variants.title")}</h2>
              <p className="text-xs text-gray-600">{t("item_form.variants.subtitle")}</p>
            </div>
            <button type="button" className="text-sm font-semibold text-blue-700 hover:underline" onClick={() => setBuilding(true)}>
              {t("item_form.variants.edit")}
            </button>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              className="text-sm font-semibold text-blue-700 hover:underline"
              onClick={() => setRows(rows.map((x) => ({ ...x, price: rows[0]!.price, mrp: rows[0]!.mrp, cost: rows[0]!.cost })))}
            >
              {t("item_form.variants.same_price")}
            </button>
          </div>
          <div className="space-y-2">
            {/* Column headers (desktop). On phones each field carries its own label instead. */}
            <div className={`hidden items-center gap-2 px-3 text-xs font-semibold text-gray-600 md:grid ${ROW_COLS}`}>
              <span>{axesFromRows(rows).map((a) => a.name).join(" / ") || t("item_form.variants.col_option")}</span>
              <span>{t("item_form.variants.col_price")} *</span>
              <span>{t("item_form.variants.col_mrp")}</span>
              <span>{t("item_form.variants.col_cost")}</span>
              <span>{t("item_form.variants.col_stock")}</span>
              <span>{t("item_form.variants.col_barcode")}</span>
              <span />
            </div>
            {rows.map((r, i) => (
              <div key={r.id ?? `n${i}`} className={`grid grid-cols-2 items-end gap-2 rounded-lg border border-gray-200 p-3 md:items-center ${ROW_COLS}`}>
                <div className="col-span-2 text-sm font-semibold text-gray-900 md:col-span-1">
                  {Object.values(r.options).join(" / ")}
                </div>
                <Field label={t("item_form.variants.col_price")}>
                  <input className={inputCls} inputMode="decimal" value={r.price} onChange={(e) => update(i, { price: e.target.value })} />
                </Field>
                <Field label={t("item_form.variants.col_mrp")}>
                  <input className={inputCls} inputMode="decimal" value={r.mrp} onChange={(e) => update(i, { mrp: e.target.value })} />
                </Field>
                <Field label={t("item_form.variants.col_cost")}>
                  <input className={inputCls} inputMode="decimal" value={r.cost} onChange={(e) => update(i, { cost: e.target.value })} />
                </Field>
                <Field label={t("item_form.variants.col_stock")}>
                  <input
                    className={`${inputCls} disabled:bg-gray-50`}
                    inputMode="decimal"
                    value={r.stock}
                    disabled={r.id !== undefined}
                    title={r.id !== undefined ? t("item_form.variants.stock_existing") : undefined}
                    onChange={(e) => update(i, { stock: e.target.value })}
                  />
                </Field>
                <Field label={t("item_form.variants.col_barcode")}>
                  <input className={`${inputCls} font-mono`} value={r.barcode} onChange={(e) => update(i, { barcode: e.target.value })} />
                </Field>
                <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  {t("item_form.variants.remove")}
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <button type="button" data-testid="variant-add" className="text-sm font-semibold text-blue-700 hover:underline" onClick={() => setBuilding(true)}>
          + {t("item_form.variants.add")}
        </button>
      )}
    </section>
  );
}
