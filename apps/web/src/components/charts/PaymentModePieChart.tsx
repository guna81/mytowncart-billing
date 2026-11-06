// SPDX-License-Identifier: Apache-2.0
import { formatPaise } from "@mytowncart-billing/core";

export interface PaymentModeSlice {
  mode: string;
  amountPaise: number;
  count?: number;
}

const COLORS: Record<string, string> = {
  cash: "#10B981", // Emerald
  upi: "#3B82F6",  // Blue
  card: "#8B5CF6", // Purple
  credit: "#F59E0B", // Amber
};

export function PaymentModePieChart({
  slices,
  size = 180,
}: {
  slices: PaymentModeSlice[];
  size?: number;
}) {
  const totalAmount = slices.reduce((s, sl) => s + sl.amountPaise, 0);

  if (totalAmount === 0) {
    return (
      <div className="flex h-44 items-center justify-center text-xs text-gray-400">
        No payment data available.
      </div>
    );
  }

  // Calculate SVG arc paths for donut chart
  const radius = size / 2;
  const innerRadius = radius * 0.58;
  const center = radius;

  let cumulativeAngle = -Math.PI / 2;

  const arcs = slices
    .filter((s) => s.amountPaise > 0)
    .map((slice) => {
      const angle = (slice.amountPaise / totalAmount) * 2 * Math.PI;
      const startAngle = cumulativeAngle;
      const endAngle = cumulativeAngle + angle;
      cumulativeAngle = endAngle;

      const x1 = center + radius * Math.cos(startAngle);
      const y1 = center + radius * Math.sin(startAngle);
      const x2 = center + radius * Math.cos(endAngle);
      const y2 = center + radius * Math.sin(endAngle);

      const ix1 = center + innerRadius * Math.cos(endAngle);
      const iy1 = center + innerRadius * Math.sin(endAngle);
      const ix2 = center + innerRadius * Math.cos(startAngle);
      const iy2 = center + innerRadius * Math.sin(startAngle);

      const largeArc = angle > Math.PI ? 1 : 0;

      const pathData = `
        M ${x1} ${y1}
        A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}
        L ${ix1} ${iy1}
        A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix2} ${iy2}
        Z
      `;

      return {
        slice,
        pathData,
        color: COLORS[slice.mode] || "#6B7280",
        percentage: Math.round((slice.amountPaise / totalAmount) * 100),
      };
    });

  return (
    <div className="flex flex-col sm:flex-row items-center justify-center gap-6" data-testid="payment-mode-chart">
      {/* SVG Donut */}
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        {arcs.map((arc, idx) => (
          <path
            key={idx}
            d={arc.pathData}
            fill={arc.color}
            stroke="#FFFFFF"
            strokeWidth="2"
            className="transition-opacity hover:opacity-85"
          >
            <title>{`${arc.slice.mode.toUpperCase()}: ₹${formatPaise(arc.slice.amountPaise)} (${arc.percentage}%)`}</title>
          </path>
        ))}
        {/* Center label */}
        <text
          x={center}
          y={center - 6}
          textAnchor="middle"
          className="text-[10px] font-bold uppercase tracking-wider fill-gray-400 font-sans"
        >
          Total
        </text>
        <text
          x={center}
          y={center + 14}
          textAnchor="middle"
          className="text-xs font-bold fill-gray-900 font-sans"
        >
          ₹{formatPaise(totalAmount)}
        </text>
      </svg>

      {/* Legend */}
      <div className="space-y-1.5 text-xs">
        {arcs.map((arc, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <span
              className="h-3 w-3 rounded-sm shrink-0"
              style={{ backgroundColor: arc.color }}
            />
            <span className="font-medium text-gray-700 capitalize">{arc.slice.mode}</span>
            <span className="text-gray-400 font-mono">({arc.percentage}%)</span>
            <span className="font-mono text-gray-900 font-semibold ml-auto">
              ₹{formatPaise(arc.slice.amountPaise)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
