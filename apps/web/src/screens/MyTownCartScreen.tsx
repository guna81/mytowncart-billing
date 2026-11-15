// SPDX-License-Identifier: Apache-2.0
/**
 * MyTownCart page (roadmap §8.5, work package B2; tabs: Overview / Settings): connect with a device code,
 * map local categories once, review what can be published, then publish the
 * whole catalog. Item states are shown honestly — a hidden item or unapproved
 * store is never presented as "live".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import {
  formatPaise,
  groupMarketplaceCategories,
  suggestCategories,
  suggestCategoryForItem,
} from "@mytowncart-billing/core";
import {
  CLIENT_NAME,
  CONNECT_SCOPES,
  MarketplaceError,
  type ConnectionToken,
  type MarketplaceCategory,
  type MarketplaceProfile,
  type UpsertResult,
} from "@mytowncart-billing/connector-mytowncart";
import type { Category, Item, OutboxRow, RemoteItemLink } from "@mytowncart-billing/storage";
import { Modal, PageHeader } from "../components/ui";
import { t, type I18nKey } from "../i18n";
import { assignMarketplaceCategory } from "../lib/categoryAssign";
import { withReconciliationLock } from "../lib/autoSync";
import { publishCatalogItems } from "../lib/publishService";
import { classifyCatalogOverview } from "../lib/catalogOverview";
import { invalidateRemoteSeen, loadRemoteSeen } from "../lib/remoteSeen";
import { syncAvailable } from "../lib/syncEngine";
import { activeStockSources } from "../lib/reconcileFixes";
import { clearConnection, loadConnection, saveConnection } from "../lib/connection";
import { getConnector } from "../lib/marketplace";
import { openReleasePage } from "../lib/tauri";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";
import { Pagination, SyncPanel, usePagination } from "./SyncPanel";
import { SyncSettingsPanel } from "./SyncSettingsPanel";

type Phase = "boot" | "disconnected" | "connecting" | "connected";

const btnPrimary =
  "rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300";
const btnSecondary = "rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50";

function errorText(err: unknown): string {
  if (err instanceof MarketplaceError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Honest state for one upsert result, given where the item ended up. */
export function stateForResult(result: UpsertResult, storeApproved: boolean): string {
  if (result.status === "error") return "error";
  if (!storeApproved) return "pending_store_approval";
  // A billing-managed item with no image is published hidden (D9); the server
  // reports it as not visible, so mirror that rather than claiming "live".
  return result.visible ? "live" : "hidden";
}

function ConnectPanel({
  onConnected,
  onWaiting,
  onFailed,
  error,
  setError,
}: {
  onConnected(token: ConnectionToken): void;
  onWaiting(): void;
  onFailed(): void;
  error: string | null;
  setError(message: string | null): void;
}) {
  const [session, setSession] = useState<{ userCode: string; verificationUrl: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const cancelled = useRef(false);

  // StrictMode mounts, unmounts, then remounts, so reset on mount or the flag stays true.
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const start = async () => {
    setError(null);
    setStarting(true);
    onWaiting();
    try {
      const connector = getConnector();
      // The token must be live before me() runs, so persist it the moment it is minted.
      const next = await connector.connect(CLIENT_NAME, [...CONNECT_SCOPES]);
      setSession({ userCode: next.userCode, verificationUrl: next.verificationUrl });
      await next.waitForApproval();
      const minted = connector.takeMintedToken();
      if (!minted) throw new Error("The marketplace did not issue a token.");
      await saveConnection(minted);
      if (!cancelled.current) onConnected(minted);
    } catch (err) {
      if (cancelled.current) return;
      setSession(null);
      setStarting(false);
      onFailed();
      const code = err instanceof MarketplaceError ? err.code : "";
      if (code === "access_denied") setError(t("mtc.denied"));
      else if (code === "expired_token") setError(t("mtc.expired"));
      else setError(t("mtc.connect_failed", { message: errorText(err) }));
    }
  };

  return (
    <section className="rounded border border-gray-200 bg-white p-4" data-testid="mtc-connect">
      <p className="text-sm text-gray-700">{t("mtc.placeholder")}</p>
      <p className="mt-1 text-sm text-gray-500">{t("mtc.connect_intro")}</p>

      {session ? (
        <div className="mt-4 rounded bg-blue-50 p-3" data-testid="mtc-code-panel">
          <p className="text-sm text-gray-700">{t("mtc.connect_step")}</p>
          <p className="my-2 font-mono text-2xl font-bold tracking-widest" data-testid="mtc-user-code">
            {session.userCode}
          </p>
          <a
            className="text-sm text-blue-700 underline"
            data-testid="mtc-open-link"
            href={session.verificationUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              void openReleasePage(session.verificationUrl).catch(() => {});
            }}
          >
            {t("mtc.open_link")}
          </a>
          <p className="mt-2 text-sm text-gray-600">{t("mtc.waiting")}</p>
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 text-sm text-red-600" data-testid="mtc-connect-error">
          {error}
        </p>
      ) : null}

      {!session ? (
        <button
          type="button"
          className={`${btnPrimary} mt-3`}
          data-testid="mtc-connect-start"
          disabled={starting}
          onClick={() => void start()}
        >
          {t("mtc.connect")}
        </button>
      ) : null}
    </section>
  );
}

function CategoryMapping({
  categories,
  marketplace,
  onSave,
}: {
  categories: Category[];
  marketplace: MarketplaceCategory[];
  onSave(): void;
}) {
  const [draft, setDraft] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      categories
        .filter((c) => c.marketplaceCategoryId !== null)
        .map((c) => [c.id, c.marketplaceCategoryId as string]),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Add category modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [newCatMarketplaceId, setNewCatMarketplaceId] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const newSuggestions = useMemo(() => {
    if (!newCatName.trim() || marketplace.length === 0) return [];
    return suggestCategories(newCatName.trim(), marketplace, 3);
  }, [newCatName, marketplace]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    const repo = getRepository();
    for (const category of categories) {
      const next = draft[category.id] || null;
      if (next !== category.marketplaceCategoryId) {
        await repo.setCategoryMarketplaceId(category.id, next);
      }
    }
    setSaving(false);
    setSaved(true);
    onSave();
  };

  const handleAddCategory = async () => {
    const trimmed = newCatName.trim();
    if (!trimmed) {
      setAddError(t("categories.name_required"));
      return;
    }
    if (categories.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) {
      setAddError(t("categories.name_exists"));
      return;
    }

    setAdding(true);
    setAddError(null);
    try {
      const repo = getRepository();
      const id = await repo.upsertCategory({ name: trimmed });
      if (newCatMarketplaceId) {
        await repo.setCategoryMarketplaceId(id, newCatMarketplaceId);
      }
      setShowAddModal(false);
      setNewCatName("");
      setNewCatMarketplaceId("");
      onSave();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="rounded border border-gray-200 bg-white p-4" data-testid="mtc-mapping">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">{t("mtc.mapping")}</h2>
          <p className="mt-1 text-sm text-gray-500">{t("mtc.mapping_intro")}</p>
        </div>
        <button
          type="button"
          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
          data-testid="mtc-mapping-add-btn"
          onClick={() => {
            setNewCatName("");
            setNewCatMarketplaceId("");
            setAddError(null);
            setShowAddModal(true);
          }}
        >
          + {t("mtc.mapping_add_category")}
        </button>
      </div>

      {categories.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-6 text-center">
          <p className="text-sm text-gray-500">{t("mtc.mapping_none")}</p>
          <button
            type="button"
            className={`${btnPrimary} mt-3`}
            data-testid="mtc-mapping-add-first-btn"
            onClick={() => {
              setNewCatName("");
              setNewCatMarketplaceId("");
              setAddError(null);
              setShowAddModal(true);
            }}
          >
            + {t("mtc.mapping_add_category")}
          </button>
        </div>
      ) : (
        <table className="mt-3 w-full text-sm">
          <tbody>
            {categories.map((category) => {
              const suggestions = suggestCategories(category.name, marketplace, 3);
              return (
                <tr key={category.id} className="border-t border-gray-100">
                  <td className="py-2 pr-4 font-medium">{category.name}</td>
                  <td className="py-2">
                    <select
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 shadow-2xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      data-testid={`mtc-map-${category.id}`}
                      value={draft[category.id] ?? ""}
                      onChange={(e) => {
                        setSaved(false);
                        setDraft((d) => ({ ...d, [category.id]: e.target.value }));
                      }}
                    >
                      <option value="">{t("mtc.mapping_unmapped")}</option>
                      {marketplace.map((m) => (
                        <option key={m.id} value={m.id}>
                          {suggestions.some((s) => s.id === m.id)
                            ? `${m.name} (${t("mtc.mapping_suggested")})`
                            : m.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          className={btnPrimary}
          data-testid="mtc-mapping-save"
          disabled={saving || categories.length === 0}
          onClick={() => void save()}
        >
          {t("mtc.mapping_save")}
        </button>
        {saved ? (
          <span className="text-sm text-green-700" data-testid="mtc-mapping-saved">
            {t("mtc.mapping_saved")}
          </span>
        ) : null}
      </div>

      {/* Add Category Modal */}
      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title={t("categories.new_dialog_title")}
        dataTestId="mtc-add-category-modal"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleAddCategory();
          }}
          className="space-y-4"
        >
          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1">
              {t("categories.name")} *
            </label>
            <input
              autoFocus
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="e.g. Snacks, Beverages, Dairy"
              data-testid="mtc-new-cat-name"
              value={newCatName}
              onChange={(e) => {
                setNewCatName(e.target.value);
                setAddError(null);
              }}
            />
            {addError ? (
              <p className="mt-1 text-xs text-red-600 font-medium" data-testid="mtc-new-cat-error">
                {addError}
              </p>
            ) : null}
          </div>

          {marketplace.length > 0 ? (
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-1">
                {t("categories.marketplace_category")}
              </label>
              <select
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-2xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                data-testid="mtc-new-cat-marketplace"
                value={newCatMarketplaceId}
                onChange={(e) => setNewCatMarketplaceId(e.target.value)}
              >
                <option value="">{t("categories.select_marketplace")}</option>
                {marketplace.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>

              {newSuggestions.length > 0 && !newCatMarketplaceId ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
                  <span>Suggested:</span>
                  {newSuggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="rounded bg-blue-50 px-2 py-0.5 text-blue-700 hover:bg-blue-100"
                      onClick={() => setNewCatMarketplaceId(s.id)}
                    >
                      + {s.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-5 flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
            <button
              type="button"
              className={btnSecondary}
              onClick={() => setShowAddModal(false)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className={btnPrimary}
              disabled={adding}
              data-testid="mtc-new-cat-save"
            >
              {adding ? t("common.saving") : t("categories.add")}
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}

export function MyTownCartScreen() {
  const dataVersion = useAppStore((s) => s.dataVersion);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);
  const sellerIsApproved = useAppStore((s) => s.sellerIsApproved);
  const setSellerIsApproved = useAppStore((s) => s.setSellerIsApproved);

  const [phase, setPhase] = useState<Phase>("boot");
  const [tab, setTab] = useState<"overview" | "settings">("overview");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [profile, setProfile] = useState<MarketplaceProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [marketplace, setMarketplace] = useState<MarketplaceCategory[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const loadLocal = useCallback(async () => {
    const repo = getRepository();
    setCategories(await repo.listCategories());
    setItems(await repo.listItems({ activeOnly: true }));
  }, []);

  const loadRemote = useCallback(async (token: ConnectionToken) => {
    void token;
    const connector = getConnector();
    setProfileError(null);
    try {
      const me = await connector.me();
      setProfile(me);
      setSellerIsApproved(me.sellerIsApproved);
      setMarketplace(await connector.listCategories());
    } catch (err) {
      if (err instanceof MarketplaceError && (err.code === "unauthorized" || err.code === "expired_token")) {
        await clearConnection();
        setPhase("disconnected");
        setConnectError(t("mtc.expired"));
        return;
      }
      setProfileError(t("mtc.mapping_failed", { message: errorText(err) }));
    }
  }, [setSellerIsApproved]);

  useEffect(() => {
    void (async () => {
      try {
        const token = await loadConnection();
        await loadLocal();
        if (token) {
          setPhase("connected");
          await loadRemote(token);
        } else {
          setPhase("disconnected");
        }
      } catch (err) {
        setConnectError(t("mtc.connect_failed", { message: errorText(err) }));
        setPhase("disconnected");
      }
    })();
  }, [loadLocal, loadRemote]);

  useEffect(() => {
    void loadLocal();
  }, [dataVersion, loadLocal]);

  const onConnected = async (token: ConnectionToken) => {
    setPhase("connected");
    await loadRemote(token);
    bumpDataVersion();
  };

  const disconnect = async () => {
    await clearConnection();
    setProfile(null);
    setMarketplace(null);
    setPhase("disconnected");
  };

  if (phase === "boot") {
    return <p className="text-sm text-gray-500">{t("common.loading")}</p>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-24" data-testid="mtc-screen">
      <PageHeader title={t("mtc.title")} />

      {phase !== "connected" ? (
        <ConnectPanel
          error={connectError}
          setError={setConnectError}
          onWaiting={() => setPhase("connecting")}
          onFailed={() => setPhase("disconnected")}
          onConnected={(token) => void onConnected(token)}
        />
      ) : (
        <>
          <section className="rounded border border-gray-200 bg-white p-4" data-testid="mtc-account">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold" data-testid="mtc-connected-as">
                  {t("mtc.connected_as", { name: profile?.sellerName ?? "" })}
                </p>
                <p
                  className={`mt-1 text-sm ${sellerIsApproved ? "text-green-700" : "text-amber-800"}`}
                  data-testid="mtc-store-status"
                >
                  {sellerIsApproved ? t("mtc.store_approved") : t("mtc.store_pending")}
                </p>
              </div>
              <button
                type="button"
                className={btnSecondary}
                data-testid="mtc-disconnect"
                onClick={() => void disconnect()}
              >
                {t("mtc.disconnect")}
              </button>
            </div>
            {profileError ? (
              <p className="mt-2 text-sm text-red-600" data-testid="mtc-profile-error">
                {profileError}
              </p>
            ) : null}
          </section>

          <div className="flex gap-1 border-b border-gray-200" role="tablist">
            {(
              [
                ["overview", "mtc.tab.overview"],
                ["settings", "mtc.tab.settings"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                data-testid={`mtc-tab-${key}`}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                  tab === key
                    ? "border-blue-600 font-semibold text-blue-700"
                    : "border-transparent text-gray-600 hover:text-gray-900"
                }`}
                onClick={() => setTab(key)}
              >
                {t(label)}
              </button>
            ))}
          </div>

          {tab === "overview" ? (
            <SyncPanel
              categoryMapping={
                marketplace === null ? null : (
                  <CategoryMapping
                    categories={categories}
                    marketplace={marketplace}
                    onSave={() => bumpDataVersion()}
                  />
                )
              }
              itemStatus={
                marketplace === null ? null : (
                  <ReviewTable
                    items={items}
                    marketplace={marketplace}
                    categories={categories}
                    onChanged={() => bumpDataVersion()}
                  />
                )
              }
            />
          ) : null}

          {tab === "settings" ? (
            <div className="space-y-4">
              <SyncPanel part="sync" />
              <SyncSettingsPanel />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Separate publish readiness from marketplace reconciliation and visibility. */
function ReviewTable({ items, marketplace, categories, onChanged }: {
  items: Item[];
  marketplace: MarketplaceCategory[];
  categories: Category[];
  onChanged(): void;
}) {
  const dataVersion = useAppStore((s) => s.dataVersion);
  const isSyncing = useAppStore((s) => s.isSyncing);
  const approved = useAppStore((s) => s.sellerIsApproved);
  const [snapshot, setSnapshot] = useState<{ seen: Map<string, RemoteItemLink> | null; pending: OutboxRow[] } | null>(null);
  const [stockBlocked, setStockBlocked] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [publishNote, setPublishNote] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const repo = getRepository();
    setSnapshot(null);
    void Promise.all([loadRemoteSeen(new Date(), repo), repo.listOutbox("pending"), repo.listOutbox("quarantined"), repo.listStockReconciliations(), repo.listStockSourceResolutions()])
      .then(([seen, pending, quarantined, intents, history]) => { if (!cancelled) {
        const active = activeStockSources(quarantined, history);
        setSnapshot({ seen, pending: [...pending, ...active] });
        setStockBlocked(active.length + intents.filter((intent) => (intent.status === "pending" || intent.status === "needs_review") && !intents.some((child) => child.parentOperationId === intent.operationId && child.status !== "conflict")).length);
      } })
      .catch(() => { if (!cancelled) setSnapshot({ seen: null, pending: [] }); });
    return () => { cancelled = true; };
  }, [dataVersion]);

  const overview = useMemo(() => classifyCatalogOverview(items, categories, marketplace, snapshot?.seen ?? null, snapshot?.pending ?? []), [items, categories, marketplace, snapshot]);
  const ready = overview.items.filter((entry) => entry.status === "ready");
  const blocked = overview.items.filter((entry) => entry.status === "blocked");
  const readyPage = usePagination(ready);
  const blockedPage = usePagination(blocked);
  const groups = useMemo(() => groupMarketplaceCategories(marketplace), [marketplace]);
  const mappedHints = useMemo(() => {
    const mapped = new Map(categories.map((c) => [c.id, c.marketplaceCategoryId]));
    return items.flatMap((i) => {
      const id = i.categoryId === null ? null : (mapped.get(i.categoryId) ?? null);
      return id === null ? [] : [{ name: i.name, marketplaceCategoryId: id }];
    });
  }, [items, categories]);
  const choose = async (item: Item, choice: { id: string; name: string }) => {
    await assignMarketplaceCategory(getRepository(), item, categories, choice);
    onChanged();
  };
  const publish = async () => {
    setPublishing(true);
    setPublishNote([]);
    try {
      const notes = await withReconciliationLock(async () => {
        const repo = getRepository();
        const targets = ready.map((entry) => entry.item);
        const result = await publishCatalogItems(repo, getConnector(), targets, approved === true);
        if (result.publishedCount > 0) await invalidateRemoteSeen(repo);
        const failed = result.outcomes.filter((outcome) => outcome.state === "error");
        return [t("overview.publish_result", { count: result.publishedCount }), ...result.errors,
          ...failed.map((outcome) => t("overview.failed_item", { name: targets.find((item) => item.id === outcome.itemId)?.name ?? String(outcome.itemId) })),
          ...result.blocked.map((entry) => t("overview.failed_item", { name: entry.name }))];
      });
      setPublishNote(notes);
      onChanged();
    } catch (err) {
      setPublishNote([errorText(err)]);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="mtc-states">
      {stockBlocked > 0 && <p role="status" className="rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950" data-testid="overview-stock-blocked">{t("sync.quarantined", { count: stockBlocked })}</p>}
      <section className="rounded border border-gray-200 bg-white p-4" data-testid="overview-synced">
        <h2 className="font-semibold">{overview.synced === null ? t("overview.not_checked") : t("overview.synced", { count: overview.synced })}</h2>
        <p className="mt-1 text-sm text-gray-600">{overview.synced === null ? t("overview.check_sync") : t("overview.synced_hint")}</p>
        {overview.changed > 0 && <p className="mt-1 text-sm text-amber-800">{t("overview.changed", { count: overview.changed })}</p>}
      </section>
      <section className="rounded border border-gray-200 bg-white p-4" data-testid="overview-ready">
        <h2 className="font-semibold">{t("overview.ready", { count: ready.length })}</h2>
        <p className="mt-1 text-sm text-gray-600">{t("overview.ready_hint")}</p>
        {ready.length > 0 && <button type="button" className={`${btnPrimary} mt-2`} disabled={publishing || isSyncing || !syncAvailable()} onClick={() => void publish()}>{publishing ? t("overview.publishing") : t("overview.publish", { count: ready.length })}</button>}
        {publishNote.length > 0 && <div role="status" className="mt-2 text-sm">{publishNote.map((note, i) => <p key={i}>{note}</p>)}</div>}
        {ready.length === 0 ? <p className="mt-2 text-sm text-gray-500">{t("overview.none")}</p> : <table className="mt-2 w-full text-sm"><tbody>{readyPage.visible.map(({ item }) => <tr key={item.id} className="border-t border-gray-100" data-testid={`overview-ready-${item.id}`}><td className="py-1 font-medium">{item.name}</td><td className="py-1 text-right">{formatPaise(item.pricePaise)}</td><td className="py-1 pl-4 text-right">{t("mtc.state_stock", { count: Math.trunc(item.stockMilli / 1000) })}</td></tr>)}</tbody></table>}
        <Pagination {...readyPage} label={t("overview.ready", { count: ready.length })} />
      </section>
      <section className="rounded border border-gray-200 bg-white p-4" data-testid="overview-attention">
        <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{t("overview.attention", { count: blocked.length })}</h2><Link to="/items" className="text-sm text-blue-700 hover:underline">{t("mtc.manage_items")}</Link></div>
        {blocked.length === 0 ? <p className="mt-2 text-sm text-gray-500">{t("overview.none")}</p> : <table className="mt-2 w-full text-sm"><tbody>{blockedPage.visible.map((entry) => {
          if (entry.status !== "blocked") return null;
          const { item, reason } = entry;
          return <tr key={item.id} className="border-t border-gray-100" data-testid={`mtc-state-${item.id}`}><td className="py-1 font-medium">{item.name}</td><td className="py-1 pl-4 text-right text-amber-800">{reason.code === "no_category" || reason.code === "no_category_mapping" ? <CategoryPicker itemId={item.id} groups={groups} suggestion={suggestCategoryForItem(item.name, marketplace, mappedHints)} onPick={(choice) => void choose(item, choice)} /> : t(`mtc.blocked.${reason.code}` as I18nKey)} <Link to={`/items/${item.id}/edit`} className="ml-2 text-blue-700 hover:underline">{t("overview.edit")}</Link></td></tr>;
        })}</tbody></table>}
        <Pagination {...blockedPage} label={t("overview.attention", { count: blocked.length })} />
      </section>
    </div>
  );
}

/** Inline MyTownCart category choice for one item, with a one-click suggestion. */
function CategoryPicker({
  itemId,
  groups,
  suggestion,
  onPick,
}: {
  itemId: number;
  groups: ReturnType<typeof groupMarketplaceCategories>;
  suggestion: { id: string; name: string } | null;
  onPick(choice: { id: string; name: string }): void;
}) {
  const names = new Map(groups.flatMap((g) => g.options).map((o) => [o.id, o.name]));
  const pick = (id: string) => {
    const name = names.get(id);
    if (name !== undefined) onPick({ id, name });
  };
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      {suggestion ? (
        <button
          type="button"
          className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs text-blue-800 hover:bg-blue-100"
          data-testid={`mtc-suggest-${itemId}`}
          onClick={() => onPick(suggestion)}
        >
          {t("mtc.use_suggestion", { name: suggestion.name })}
        </button>
      ) : null}
      <select
        className="rounded-lg border border-amber-300 bg-white px-2 py-1 text-sm text-gray-900"
        data-testid={`mtc-pick-category-${itemId}`}
        value=""
        aria-label={t("mtc.pick_category")}
        onChange={(e) => pick(e.target.value)}
      >
        <option value="">{t("mtc.pick_category")}</option>
        {groups.map((g) => {
          const opts = g.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ));
          return g.label === null ? opts : (
            <optgroup key={g.label} label={g.label}>
              {opts}
            </optgroup>
          );
        })}
      </select>
    </span>
  );
}
