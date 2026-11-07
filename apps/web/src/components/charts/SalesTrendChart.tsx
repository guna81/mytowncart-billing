// SPDX-License-Identifier: Apache-2.0
import { formatPaise } from "@mytowncart-billing/core";
import { t } from "../../i18n";

export interface SalesTrendPoint {
  date: string;
  totalPaise: number;
  count: number;
}

export function SalesTrendChart({
  points,
  height = 180,
}: {
  points: SalesTrendPoint[];
  height?: number;
}) {
  if (points.length < 2) {
    return (
      <div
        className="flex h-44 flex-col items-center justify-center text-xs text-gray-600 gap-2"
        data-testid="sales-trend-chart"
      >
        <svg
          className="h-8 w-8 text-gray-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
          />
        </svg>
        <span className="font-medium">
          {points.length === 0 ? t("reports.empty") : t("reports.not_enough_data")}
        </span>
      </div>
    );
  }

  const maxVal = Math.max(...points.map((p) => p.totalPaise), 1000);
  const chartHeight = height - 40;
  const chartWidth = 500;
  const stepX = chartWidth / Math.max(1, points.length - 1);

  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = chartHeight - (p.totalPaise / maxVal) * chartHeight + 10;
    return { x, y, point: p };
  });

  const pathD = coords.reduce(
    (acc, curr, idx) => (idx === 0 ? `M ${curr.x} ${curr.y}` : `${acc} L ${curr.x} ${curr.y}`),
    "",
  );

  const areaD = `${pathD} L ${coords[coords.length - 1]!.x} ${chartHeight + 10} L 0 ${chartHeight + 10} Z`;

  return (
    <div className="w-full overflow-x-auto" data-testid="sales-trend-chart">
      <svg
        viewBox={`0 0 ${chartWidth} ${height}`}
        className="w-full h-auto"
        style={{ minWidth: "300px" }}
      >
        <defs>
          <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3B82F6" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#3B82F6" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Horizontal grid guidelines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct, idx) => {
          const y = chartHeight * (1 - pct) + 10;
          return (
            <line
              key={idx}
              x1="0"
              y1={y}
              x2={chartWidth}
              y2={y}
              stroke="#E5E7EB"
              strokeDasharray="3 3"
            />
          );
        })}

        {/* Filled gradient area */}
        <path d={areaD} fill="url(#salesGrad)" />

        {/* Trend line */}
        <path
          d={pathD}
          fill="none"
          stroke="#2563EB"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Data points */}
        {coords.map((c, idx) => (
          <g key={idx}>
            <circle cx={c.x} cy={c.y} r="3.5" fill="#FFFFFF" stroke="#2563EB" strokeWidth="2" />
            <title>{`${c.point.date}: ₹${formatPaise(c.point.totalPaise)} (${c.point.count} bills)`}</title>
          </g>
        ))}

        {/* X-axis labels */}
        {coords.map((c, idx) => {
          // Show every few labels if dense
          const showLabel = points.length <= 7 || idx === 0 || idx === points.length - 1 || idx % 2 === 0;
          if (!showLabel) return null;
          return (
            <text
              key={idx}
              x={c.x}
              y={height - 5}
              textAnchor={idx === 0 ? "start" : idx === points.length - 1 ? "end" : "middle"}
              className="text-[10px] fill-gray-600 font-sans"
            >
              {c.point.date.slice(5)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
