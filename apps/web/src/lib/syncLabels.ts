// SPDX-License-Identifier: Apache-2.0
/** Seller-friendly wording for raw sync problems. */
import { t, type I18nKey } from "../i18n";

const PREFIXES: [string, I18nKey][] = [
  ["stock push:", "sync.problem.stock_push"],
  ["stock pull:", "sync.problem.stock_pull"],
  ["catalog read:", "sync.problem.catalog_read"],
  ["platform read:", "sync.problem.platform_read"],
  ["catalog:", "sync.problem.catalog"],
];

/** Maps an engine problem line (`step: detail`) to one plain sentence. */
export function friendlyProblem(raw: string): string {
  for (const [prefix, key] of PREFIXES) if (raw.startsWith(prefix)) return t(key);
  return t("sync.problem.item");
}
