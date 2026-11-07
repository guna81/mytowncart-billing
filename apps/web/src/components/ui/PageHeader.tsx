// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, actions, className = "" }: PageHeaderProps) {
  return (
    <header className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6 ${className}`}>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 truncate">{title}</h1>
        {subtitle ? <div className="mt-1 text-sm text-gray-600">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 flex-shrink-0">{actions}</div> : null}
    </header>
  );
}
