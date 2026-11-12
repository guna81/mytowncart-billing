// SPDX-License-Identifier: Apache-2.0
import type { Item } from "@mytowncart-billing/storage";
import { baseNameOf } from "../screens/itemForm/variants";

/**
 * Per-variant sync is off by default: with it off, every option of an item
 * group is published as its own marketplace product (the old behaviour). Turn on
 * only once the MyTownCart server has INTEGRATIONS_VARIANTS_ENABLED.
 * Enable with VITE_VARIANT_SYNC=1 or localStorage "mtc.variantSync" = "1".
 */
export function variantSyncEnabled(): boolean {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  if (env.VITE_VARIANT_SYNC === "1") return true;
  try {
    return globalThis.localStorage?.getItem("mtc.variantSync") === "1";
  } catch {
    return false;
  }
}

/** The `group` a PublishItem carries for an option of an item group. */
export function groupOf(item: Item | undefined) {
  if (!item || !item.variantGroup) return {};
  return {
    group: {
      id: item.variantGroup,
      name: baseNameOf(item.name, item.variantOptions),
      options: item.variantOptions,
    },
  };
}
