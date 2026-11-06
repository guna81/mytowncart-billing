// SPDX-License-Identifier: Apache-2.0
import { formatPaise } from "@mytowncart-billing/core";

export interface HourlyBucket {
  hour: number; // 0..23
  totalPaise: number;
  count: number;
}

export function HourlyHeatmap({
  buckets,
  height = 140,
}: {
  buckets: HourlyBucket[];
  height?: number;
}) {
  const maxVal = Math.max(...buckets.map((b) => b.totalPaise), 100);
  const chartHeight = height - 28;
  const barWidth = 14;
  const gap = 5;
  const totalWidth = 24 * (barWidth + gap);

  return (
    <div className="w-full overflow-x-auto" data-testid="hourly-heatmap-chart">
      <svg
        viewBox={`0 0 ${totalWidth} ${height}`}
        className="w-full h-auto"
        style={{ minWidth: "400px" }}
      >
        {buckets.map((b) => {
          const x = b.hour * (barWidth + gap);
          const barH = (b.totalPaise / maxVal) * chartHeight;
          const y = chartHeight - barH + 6;
          const intensity = Math.min(1, b.totalPaise / maxVal);
          const fillColor = b.totalPaise === 0 ? "#E5E7EB" : `rgba(37, 99, 235, ${Math.max(0.3, intensity)})`;
          const tooltip = `${String(b.hour).padStart(2, "0")}:00 - ${String(b.hour).padStart(2, "0")}:59: ₹${formatPaise(b.totalPaise)} (${b.count} bills)`;

          return (
            <g key={b.hour}>
              <rect
                x={x}
                y={b.totalPaise === 0 ? chartHeight + 2 : y}
                width={barWidth}
                height={b.totalPaise === 0 ? 4 : Math.max(4, barH)}
                rx="2"
                fill={fillColor}
                tabIndex={0}
                role="graphics-symbol"
                aria-label={tooltip}
                className="transition-all hover:opacity-80 focus:outline-none focus:stroke-blue-600 focus:stroke-1 cursor-pointer"
              >
                <title>{tooltip}</title>
              </rect>

              {/* Hour marker */}
              {(b.hour % 3 === 0 || b.hour === 23) && (
                <text
                  x={x + barWidth / 2}
                  y={height - 4}
                  textAnchor="middle"
                  className="text-[7.5px] fill-gray-500 font-mono"
                >
                  {b.hour}h
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
