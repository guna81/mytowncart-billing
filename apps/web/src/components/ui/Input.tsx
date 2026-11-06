// SPDX-License-Identifier: Apache-2.0
import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string | null;
  leftAddon?: ReactNode;
  rightAddon?: ReactNode;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      leftAddon,
      rightAddon,
      className = "",
      containerClassName = "",
      id,
      ...props
    },
    ref,
  ) => {
    return (
      <div className={`w-full ${containerClassName}`}>
        {label ? (
          <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wider text-gray-700 mb-1">
            {label}
          </label>
        ) : null}
        <div className="relative flex items-center rounded-lg border border-gray-300 bg-white shadow-sm focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 transition-all">
          {leftAddon ? (
            <span className="pl-3 text-sm font-medium text-gray-400 select-none">{leftAddon}</span>
          ) : null}
          <input
            ref={ref}
            id={id}
            className={`w-full rounded-lg bg-transparent px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none disabled:bg-gray-50 disabled:text-gray-500 ${className}`}
            {...props}
          />
          {rightAddon ? (
            <span className="pr-3 text-sm text-gray-400 select-none">{rightAddon}</span>
          ) : null}
        </div>
        {error ? <p className="mt-1 text-xs text-red-600 font-medium">{error}</p> : null}
      </div>
    );
  },
);

Input.displayName = "Input";
