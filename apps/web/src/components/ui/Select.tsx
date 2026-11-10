// SPDX-License-Identifier: Apache-2.0
import { forwardRef, type ReactNode, type SelectHTMLAttributes } from "react";

export interface SelectOption {
  value: string | number;
  label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  containerClassName?: string;
  options?: SelectOption[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      hint,
      error,
      options,
      className = "",
      containerClassName = "",
      id,
      children,
      ...props
    },
    ref,
  ) => {
    return (
      <div className={`w-full ${containerClassName}`}>
        {label || hint ? (
          <div className="flex items-center justify-between mb-1">
            {label ? (
              <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wider text-gray-700">
                {label}
              </label>
            ) : <span />}
            {hint ? <span className="text-xs text-gray-500 font-normal">{hint}</span> : null}
          </div>
        ) : null}
        <select
          ref={ref}
          id={id}
          className={`w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-2xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500 cursor-pointer ${className}`}
          {...props}
        >
          {options
            ? options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))
            : children}
        </select>
        {error ? <p className="mt-1 text-xs text-red-600 font-medium">{error}</p> : null}
      </div>
    );
  },
);

Select.displayName = "Select";
