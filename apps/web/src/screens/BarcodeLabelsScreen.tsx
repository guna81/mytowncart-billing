// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatPaise } from "@mytowncart-billing/core";
import type { Item } from "@mytowncart-billing/storage";
import { Button, PageHeader } from "../components/ui";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

/**
 * Deterministic bar-width pattern generator for Code-128-style barcode display in SVG.
 */
function generateBarcodeBars(code: string): boolean[] {
  const bars: boolean[] = [true, false, true, true, false, false]; // Start marker
  let hash = 0;
  for (let i = 0; i < code.length; i++) {
    const charCode = code.charCodeAt(i);
    hash = (hash * 31 + charCode) % 1000;
    // Each char encodes into 6-10 bar/space modules
    const pattern = [
      true,
      (charCode & 1) === 0,
      (charCode & 2) === 0,
      (charCode & 4) !== 0,
      false,
      (charCode & 8) === 0,
      true,
      false,
    ];
    bars.push(...pattern);
  }
  bars.push(true, true, false, false, true, false, true, true); // Stop marker
  return bars;
}

export function BarcodeSvg({
  code,
  width = 180,
  height = 50,
}: {
  code: string;
  width?: number;
  height?: number;
}) {
  const bars = generateBarcodeBars(code);
  const barWidth = width / bars.length;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="mx-auto">
      {bars.map((isBar, idx) =>
        isBar ? (
          <rect
            key={idx}
            x={idx * barWidth}
            y={0}
            width={barWidth + 0.2}
            height={height}
            fill="#000"
          />
        ) : null,
      )}
    </svg>
  );
}

export function BarcodeLabelsScreen() {
  const profile = useAppStore((s) => s.profile);
  const [items, setItems] = useState<Item[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<number | "">("");
  const [labelCount, setLabelCount] = useState(24);
  const [layout, setLayout] = useState<"a4-24" | "a4-30" | "roll">("a4-24");

  useEffect(() => {
    void getRepository()
      .listItems({ activeOnly: true })
      .then((res) => {
        setItems(res);
        if (res.length > 0 && selectedItemId === "") {
          setSelectedItemId(res[0]!.id);
        }
      });
  }, []);

  const selectedItem = items.find((i) => i.id === selectedItemId);

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="space-y-6">
      {/* Screen Header (Hidden in Print) */}
      <div className="print:hidden">
        <PageHeader
          title="Print Barcode Labels"
          subtitle={
            <div className="flex items-center gap-2 text-xs text-gray-600">
              <Link to="/items" className="hover:underline">
                {t("items.title")}
              </Link>
              <span>/</span>
              <span>Barcode Sticker Generator</span>
            </div>
          }
          actions={
            <>
              <Button
                type="button"
                variant="primary"
                data-testid="print-labels-action"
                onClick={handlePrint}
                disabled={!selectedItem}
              >
                🖨️ Print Labels
              </Button>
              <Link
                to="/items"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors shadow-2xs"
              >
                Back
              </Link>
            </>
          }
        />
      </div>

      {/* Configuration Controls (Hidden in Print) */}
      <div className="print:hidden grid grid-cols-1 md:grid-cols-3 gap-4 rounded-xl border border-gray-200 bg-white p-4 shadow-xs">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-600 mb-1">
            Select Product
          </label>
          <select
            data-testid="barcode-item-select"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
            value={selectedItemId}
            onChange={(e) => setSelectedItemId(Number(e.target.value))}
          >
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} · {i.barcode || "No Barcode"} · ₹{formatPaise(i.pricePaise)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-600 mb-1">
            Sticker Sheet Layout
          </label>
          <select
            data-testid="barcode-layout-select"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
            value={layout}
            onChange={(e) => {
              const val = e.target.value as "a4-24" | "a4-30" | "roll";
              setLayout(val);
              if (val === "a4-24") setLabelCount(24);
              else if (val === "a4-30") setLabelCount(30);
              else setLabelCount(10);
            }}
          >
            <option value="a4-24">A4 Sheet — 24 Labels (3 columns × 8 rows)</option>
            <option value="a4-30">A4 Sheet — 30 Labels (3 columns × 10 rows)</option>
            <option value="roll">Thermal Roll — 50mm × 25mm Continuous</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-600 mb-1">
            Number of Labels
          </label>
          <input
            type="number"
            min="1"
            max="120"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            data-testid="barcode-label-count"
            value={labelCount}
            onChange={(e) => setLabelCount(Math.max(1, parseInt(e.target.value) || 1))}
          />
        </div>
      </div>

      {/* Label Sheet Preview & Print Container */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-xs" data-testid="barcode-sheet-container">
        {!selectedItem ? (
          <p className="text-center text-gray-500 py-8">Select an item to preview stickers.</p>
        ) : (
          <div>
            <div className="print:hidden mb-4 text-xs font-medium text-gray-500 flex justify-between">
              <span>Previewing {labelCount} labels for: <strong className="text-gray-800">{selectedItem.name}</strong></span>
              <span>Shop: {profile?.name || "Store"}</span>
            </div>

            <div
              className={
                layout === "roll"
                  ? "flex flex-col items-center gap-3"
                  : layout === "a4-30"
                  ? "grid grid-cols-3 gap-2 p-2 border border-dashed border-gray-300 rounded bg-white"
                  : "grid grid-cols-3 gap-3 p-3 border border-dashed border-gray-300 rounded bg-white"
              }
            >
              {Array.from({ length: labelCount }).map((_, idx) => (
                <div
                  key={idx}
                  data-testid="barcode-label"
                  className="rounded border border-gray-300 p-2 text-center bg-white flex flex-col justify-between"
                  style={{ minHeight: "95px", pageBreakInside: "avoid" }}
                >
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-700 truncate">
                    {profile?.name || "MY TOWN CART"}
                  </div>
                  <div className="text-xs font-semibold text-gray-900 truncate my-0.5">
                    {selectedItem.name}
                  </div>

                  <div className="my-1">
                    <BarcodeSvg code={selectedItem.barcode || `ITEM${selectedItem.id}`} width={160} height={36} />
                  </div>

                  <div className="flex items-center justify-between text-[11px] font-mono px-1 text-gray-700">
                    <span>{selectedItem.barcode || `ITEM${selectedItem.id}`}</span>
                    <span className="font-bold text-gray-900 font-sans">
                      ₹{formatPaise(selectedItem.pricePaise)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
