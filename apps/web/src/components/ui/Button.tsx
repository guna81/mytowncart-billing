// SPDX-License-Identifier: Apache-2.0
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "success" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-700 shadow-sm disabled:bg-blue-300",
  secondary: "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 shadow-sm disabled:opacity-50",
  danger: "bg-red-600 text-white hover:bg-red-700 shadow-sm disabled:bg-red-300",
  success: "bg-green-600 text-white hover:bg-green-700 shadow-sm disabled:bg-green-300",
  ghost: "text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3.5 py-1.5 text-sm",
  lg: "px-5 py-2.5 text-base font-medium",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  loading = false,
  disabled,
  children,
  ...props
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center font-semibold rounded-md transition-colors select-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {loading ? (
        <span className="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-solid border-current border-r-transparent" />
      ) : null}
      {children}
    </button>
  );
}
