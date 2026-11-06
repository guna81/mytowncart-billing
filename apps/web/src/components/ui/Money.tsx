// SPDX-License-Identifier: Apache-2.0
import type { HTMLAttributes } from "react";

export function formatIndianRupees(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const absRupees = Math.abs(paise) / 100;
  const formatted = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(absRupees);
  return `${sign}₹${formatted}`;
}

export function Money({
  paise,
  showSign = false,
  className = "",
  ...props
}: {
  paise: number;
  showSign?: boolean;
} & HTMLAttributes<HTMLSpanElement>) {
  const text = formatIndianRupees(paise);
  const displayText = showSign && paise > 0 ? `+${text}` : text;
  return (
    <span className={`font-mono font-medium ${className}`} {...props}>
      {displayText}
    </span>
  );
}
