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

  return (
    <div className="w-full" data-testid="hourly-heatmap-chart">
      <div className="flex items-end gap-1 sm:gap-1.5 pt-2" style={{ height }}>
        {buckets.map((b) => {
          const pct = Math.round((b.totalPaise / maxVal) * 100);
          const hasData = b.totalPaise > 0;
          const tooltip = `${String(b.hour).padStart(2, "0")}:00 - ${String(b.hour).padStart(2, "0")}:59: ₹${formatPaise(b.totalPaise)} (${b.count} bills)`;
          const showLabel = b.hour % 3 === 0;

          return (
            <div
              key={b.hour}
              className="flex-1 flex flex-col items-center h-full group relative focus:outline-none"
              tabIndex={0}
              role="img"
              aria-label={tooltip}
            >
              {/* Tooltip on hover/focus */}
              <div className="pointer-events-none absolute bottom-full mb-2 hidden group-hover:flex group-focus:flex flex-col items-center z-30 whitespace-nowrap">
                <div className="rounded bg-gray-900 px-2 py-1 text-[11px] font-medium text-white shadow-md">
                  {tooltip}
                </div>
                <div className="h-1 w-2 border-x-4 border-t-4 border-x-transparent border-t-gray-900" />
              </div>

              {/* Bar track and fill */}
              <div className="w-full flex-1 flex items-end bg-gray-100 rounded-xs overflow-hidden">
                {hasData && (
                  <div
                    style={{ height: `${Math.max(8, pct)}%` }}
                    className="w-full bg-blue-600 rounded-xs transition-all hover:bg-blue-700"
                  />
                )}
              </div>

              {/* Axis Label every 3h */}
              <div className="h-5 flex items-center justify-center">
                {showLabel ? (
                  <span className="text-xs text-gray-600 font-mono select-none">
                    {b.hour}h
                  </span>
                ) : (
                  <span className="text-xs text-transparent select-none">·</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
