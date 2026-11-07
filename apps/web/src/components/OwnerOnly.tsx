// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";

import { t } from "../i18n";
import { useIsOwner } from "../lib/roles";

/** Shows its children to the owner only (mirrors the owner-only commands in the Rust shell). */
export function OwnerOnly({ children }: { children: ReactNode }) {
  const isOwner = useIsOwner();
  if (isOwner) return <>{children}</>;
  return (
    <div className="mx-auto max-w-md rounded-lg border border-amber-200 bg-amber-50 p-6 text-center" data-testid="owner-only">
      <h2 className="text-lg font-semibold text-amber-900">{t("roles.owner_only_title")}</h2>
      <p className="mt-2 text-sm text-amber-800">{t("roles.owner_only_msg")}</p>
    </div>
  );
}
