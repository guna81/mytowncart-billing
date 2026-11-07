// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
  className = "",
  "data-testid": testId,
}: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className={`flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center shadow-sm ${className}`}
    >
      {icon ? (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gray-50 text-gray-500">
          {icon}
        </div>
      ) : (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gray-50 text-gray-500">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
            />
          </svg>
        </div>
      )}
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      {hint ? <p className="mt-1.5 max-w-md text-sm text-gray-600 leading-relaxed">{hint}</p> : null}
      {action ? <div className="mt-5 flex flex-wrap items-center justify-center gap-3">{action}</div> : null}
    </div>
  );
}
