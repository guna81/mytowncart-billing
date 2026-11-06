// SPDX-License-Identifier: Apache-2.0
import type { HTMLAttributes, ReactNode } from "react";

export type BadgeVariant = "gray" | "blue" | "green" | "amber" | "red" | "purple";

const variantClasses: Record<BadgeVariant, string> = {
  gray: "bg-gray-100 text-gray-700 border-gray-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  green: "bg-green-50 text-green-700 border-green-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  red: "bg-red-50 text-red-700 border-red-200",
  purple: "bg-purple-50 text-purple-700 border-purple-200",
};

export function Badge({
  variant = "gray",
  className = "",
  children,
  ...props
}: {
  variant?: BadgeVariant;
  children: ReactNode;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {children}
    </span>
  );
}
