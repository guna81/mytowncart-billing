// SPDX-License-Identifier: Apache-2.0
/**
 * `@mytowncart-billing/core` — pure domain logic for MyTownCart Billing.
 *
 * Boundary rule (roadmap §8.1): this package must never import react,
 * tauri, DOM, or fs. ESLint `no-restricted-imports` and this package's
 * `lib: ["ES2022"]` tsconfig enforce it.
 */

export const APP_NAME = "MyTownCart Billing" as const;

export const APP_SLUG = "mytowncart-billing" as const;

/** Semver of this release; keep in sync with the root package.json. */
export const APP_VERSION = "0.1.0" as const;

export * from "./money";
export * from "./quantity";
export * from "./tax";
export * from "./bill";
export * from "./invoice";
export * from "./stock";
export * from "./csv";
export * from "./reports";
export * from "./publish";
export * from "./media";
export * from "./sync";
