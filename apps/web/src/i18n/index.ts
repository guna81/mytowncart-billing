// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal i18n: a typed `t(key, vars)` over the English dictionary.
 * English only for v1; the dictionary lives in `en.ts` and every UI string
 * flows through this function (roadmap §8.2).
 */
import { en, type I18nKey } from "./en";

const dictionaries = { en } as const;
let locale: keyof typeof dictionaries = "en";

export function setLocale(next: keyof typeof dictionaries): void {
  locale = next;
}

export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  let out: string = dictionaries[locale][key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
}

export type { I18nKey };
