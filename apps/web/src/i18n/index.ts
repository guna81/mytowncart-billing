// SPDX-License-Identifier: Apache-2.0
/**
 * Typed `t(key, vars)` over English, Hindi (हिन्दी), and Tamil (தமிழ்) dictionaries.
 */
import { en, type I18nKey } from "./en";
import { hi } from "./hi";
import { ta } from "./ta";

export const dictionaries = { en, hi, ta } as const;
export type SupportedLocale = keyof typeof dictionaries;

let currentLocale: SupportedLocale =
  typeof localStorage !== "undefined" &&
  (localStorage.getItem("mtc_locale") === "hi" || localStorage.getItem("mtc_locale") === "ta")
    ? (localStorage.getItem("mtc_locale") as SupportedLocale)
    : "en";

export function setLocale(next: SupportedLocale): void {
  currentLocale = next;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("mtc_locale", next);
  }
}

export function getLocale(): SupportedLocale {
  return currentLocale;
}

export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  const dict = dictionaries[currentLocale] || dictionaries.en;
  let out: string = dict[key] ?? dictionaries.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
}

export type { I18nKey };
