// SPDX-License-Identifier: Apache-2.0
import { planPublish, stockUnitsOf, type BlockedReason } from "@mytowncart-billing/core";
import type { Category, Item, OutboxRow, RemoteItemLink } from "@mytowncart-billing/storage";
import { toPlanInputs } from "./publishService";

export type CatalogOverviewItem =
  | { item: Item; status: "blocked"; reason: BlockedReason }
  | { item: Item; status: "ready" | "synced" | "unknown" }
  | { item: Item; status: "changed"; reasons: CatalogChangeReason[] };

export type CatalogChangeReason =
  | "content_changed"
  | "pending_outbox"
  | "missing_remote"
  | "remote_price_changed"
  | "remote_stock_changed"
  | "remote_inactive";

export interface CatalogOverview {
  total: number;
  ready: number;
  blocked: number;
  synced: number | null;
  changed: number;
  unknown: number;
  items: CatalogOverviewItem[];
}

/** Classify active local items without fetching or mutating any state.
 * Pass null when loadRemoteSeen could not supply a usable snapshot; an empty
 * map is a known snapshot with no remote items, not an unknown snapshot.
 */
export function classifyCatalogOverview(
  items: readonly Item[],
  categories: readonly Category[],
  marketplaceCategories: readonly { id: string }[],
  remoteSeen: ReadonlyMap<string, RemoteItemLink> | null,
  outbox: readonly OutboxRow[],
): CatalogOverview {
  const active = items.filter((item) => item.isActive);
  const plan = planPublish(toPlanInputs(active, categories), marketplaceCategories);
  const readyById = new Map(plan.ready.map((entry) => [entry.input.id, entry]));
  const blockedById = new Map(plan.blocked.map((entry) => [entry.id, entry]));
  const pending = new Set(outbox.filter((row) => row.status === "pending").map((row) => row.externalId));
  const outcomes: CatalogOverviewItem[] = active.map((item) => {
    const blocked = blockedById.get(item.id);
    if (blocked) return { item, status: "blocked", reason: blocked.reason };
    const planned = readyById.get(item.id)!;
    // Match the sync engine's linkage rule: a stored publish hash also means
    // this item may already exist remotely and must not be offered as new.
    if (!item.remoteProductId && !item.remoteVariantId && item.contentHash === null) return { item, status: "ready" };
    if (!item.remoteProductId && !item.remoteVariantId) return { item, status: "unknown" };

    const reasons: CatalogChangeReason[] = [];
    if (item.contentHash !== planned.hash) reasons.push("content_changed");
    if (pending.has(planned.externalId)) reasons.push("pending_outbox");
    if (remoteSeen !== null) {
      const remote = remoteSeen.get(planned.externalId);
      if (!remote) {
        reasons.push("missing_remote");
      } else {
        if (remote.pricePaise !== item.pricePaise) reasons.push("remote_price_changed");
        if (remote.stockUnits !== stockUnitsOf(item.stockMilli)) reasons.push("remote_stock_changed");
        // Visibility is not a sync error: a successfully published item may be hidden.
      }
    }
    if (reasons.length) return { item, status: "changed", reasons };
    return { item, status: remoteSeen === null ? "unknown" : "synced" };
  });
  const count = (status: CatalogOverviewItem["status"]) => outcomes.filter((entry) => entry.status === status).length;
  return {
    total: active.length,
    ready: count("ready"),
    blocked: count("blocked"),
    synced: remoteSeen === null || count("unknown") > 0 ? null : count("synced"),
    changed: count("changed"),
    unknown: count("unknown"),
    items: outcomes,
  };
}
