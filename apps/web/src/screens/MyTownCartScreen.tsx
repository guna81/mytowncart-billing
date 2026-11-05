// SPDX-License-Identifier: Apache-2.0
/**
 * MyTownCart tab (roadmap §8.5, work package B2): connect with a device code,
 * map local categories once, review what can be published, then publish the
 * whole catalog. Item states are shown honestly — a hidden item or unapproved
 * store is never presented as "live".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  externalIdOf,
  formatPaise,
  IMAGE_MIME,
  localIsoTimestamp,
  planPublish,
  sniffImage,
  stockUnitsOf,
  suggestCategories,
  type PublishItemInput,
  type ReadyItem,
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
import type { Category, Item, PublishOutcome } from "@mytowncart-billing/storage";
import { t, type I18nKey } from "../i18n";
import { clearConnection, loadConnection, saveConnection } from "../lib/connection";
import { getConnector } from "../lib/marketplace";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";
import { SyncPanel } from "./SyncPanel";

type Phase = "boot" | "disconnected" | "connecting" | "connected";

const btnPrimary =
  "rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300";
const btnSecondary = "rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50";

function errorText(err: unknown): string {
  if (err instanceof MarketplaceError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** The catalog as the planner sees it, joined against category mappings. */
export function toPlanInputs(
  items: readonly Item[],
  categories: readonly Category[],
): PublishItemInput[] {
  const mapped = new Map(categories.map((c) => [c.id, c.marketplaceCategoryId]));
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    barcode: item.barcode,
    categoryId: item.categoryId,
    unitKind: item.unitKind,
    pricePaise: item.pricePaise,
    mrpPaise: item.mrpPaise,
    stockMilli: item.stockMilli,
    isActive: item.isActive,
    photoPath: item.photoPath,
    marketplaceCategoryId: item.categoryId === null ? null : (mapped.get(item.categoryId) ?? null),
    lastPublishedHash: item.contentHash,
  }));
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

  return (
    <section className="rounded border border-gray-200 bg-white p-4" data-testid="mtc-mapping">
      <h2 className="font-semibold">{t("mtc.mapping")}</h2>
      <p className="mt-1 text-sm text-gray-500">{t("mtc.mapping_intro")}</p>
      {categories.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">{t("mtc.mapping_none")}</p>
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
                      className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
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
    </section>
  );
}

function PublishPanel({
  ready,
  blocked,
  categories,
  lastPublishedAt,
  onPublished,
}: {
  ready: ReadyItem[];
  blocked: ReturnType<typeof planPublish>["blocked"];
  categories: readonly Category[];
  lastPublishedAt: string | null;
  onPublished(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ count: number; failed: number } | null>(null);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);
  const sellerIsApproved = useAppStore((s) => s.sellerIsApproved) === true;

  const changed = useMemo(
    () => ready.filter((r) => r.input.lastPublishedHash !== r.hash),
    [ready],
  );

  const publish = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const connector = getConnector();
      const results = await connector.upsertItems(
        changed.map((r) => ({
          externalId: r.externalId,
          name: r.input.name.trim(),
          pricePaise: r.input.pricePaise,
          mrpPaise: r.input.mrpPaise,
          stockUnits: stockUnitsOf(r.input.stockMilli) ?? 0,
          barcode: r.input.barcode === "" ? null : r.input.barcode,
          categoryId: r.input.marketplaceCategoryId as string,
          isActive: true,
          contentHash: r.hash,
        })),
      );
      const byExternal = new Map(results.map((r) => [r.externalId, r]));
      const outcomes: PublishOutcome[] = changed.map((r) => {
        const result = byExternal.get(r.externalId);
        const state = result ? stateForResult(result, sellerIsApproved) : "error";
        return {
          itemId: r.input.id,
          state,
          remoteProductId: result?.productId ?? null,
          remoteVariantId: result?.variantId ?? null,
          // Keep the previous hash when the publish failed so a retry re-sends it.
          contentHash: result && result.status !== "error" ? r.hash : null,
        };
      });
      // Record the mapping we actually sent, so toPlanInputs sees the same hash next time.
      const mappings = new Map(
        categories.flatMap((c) =>
          c.marketplaceCategoryId === null ? [] : [[c.id, c.marketplaceCategoryId] as const],
        ),
      );
      await getRepository().recordPublish(outcomes, mappings);
      setDone({ count: outcomes.length, failed: outcomes.filter((o) => o.state === "error").length });
      bumpDataVersion();
      onPublished();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded border border-gray-200 bg-white p-4" data-testid="mtc-publish">
      <h2 className="font-semibold">{t("mtc.publish")}</h2>
      <p className="mt-1 text-sm text-gray-600" data-testid="mtc-review">
        {t("mtc.review", { ready: ready.length, blocked: blocked.length })}
      </p>
      <p className="mt-1 text-xs text-gray-500">
        {lastPublishedAt
          ? t("mtc.last_published", { when: new Date(lastPublishedAt).toLocaleString() })
          : t("mtc.never_published")}
      </p>

      {blocked.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm" data-testid="mtc-blocked">
          {blocked.map((b) => (
            <li key={b.id} className="flex justify-between gap-4 rounded bg-amber-50 px-2 py-1">
              <span className="font-medium">{b.name}</span>
              <span className="text-amber-800">
                {t(`mtc.blocked.${b.reason.code}` as I18nKey)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p className="mt-3 text-sm text-red-600" data-testid="mtc-publish-error">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="mt-3 text-sm text-green-700" data-testid="mtc-publish-done">
          {t("mtc.publish_done", { count: done.count - done.failed })}
          {done.failed > 0 ? ` · ${done.failed} failed` : ""}
        </p>
      ) : null}

      <button
        type="button"
        className={`${btnPrimary} mt-3`}
        data-testid="mtc-publish-cta"
        disabled={busy || changed.length === 0}
        onClick={() => void publish()}
      >
        {busy ? t("mtc.publishing") : t("mtc.publish_cta", { count: changed.length })}
      </button>
      <p className="mt-1 text-xs text-gray-500">{t("mtc.publish_changed_only")}</p>
    </section>
  );
}

/**
 * D9: the marketplace keeps a published item hidden until a photo arrives, so
 * every linked item with a local photo that was never acknowledged is uploaded
 * here. After the last upload the item is upserted again, which flips it live.
 */
function PhotoPanel({
  items,
  onDone,
}: {
  items: Item[];
  onDone(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ ok: number; total: number } | null>(null);

  const pending = useMemo(
    () =>
      items.filter(
        (i) =>
          i.remoteProductId !== null &&
          i.photoFile !== "" &&
          i.imageHash !== null &&
          i.imageUploadedAt !== i.imageHash,
      ),
    [items],
  );

  const upload = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    const repo = getRepository();
    const connector = getConnector();
    let ok = 0;
    try {
      for (const item of pending) {
        const photo = await repo.readItemPhoto(item.id);
        if (!photo || photo.imageHash === null || photo.imageHash !== item.imageHash) continue;
        const imageHash = photo.imageHash;
        try {
          const blob = new Blob([photo.bytes as BlobPart], {
            type: IMAGE_MIME[sniffImage(photo.bytes) ?? "jpeg"],
          });
          await connector.uploadImage(externalIdOf(item.id), blob, !item.imageUploadedAt);
          await repo.recordImageUploads([
            {
              itemId: item.id,
              imageHash,
              uploadedAt: localIsoTimestamp(new Date()),
            },
          ]);
          ok++;
        } catch {
          // One failed upload must not stop the rest; the summary reports it.
        }
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDone({ ok, total: pending.length });
      setBusy(false);
      onDone();
    }
  };

  return (
    <section className="rounded border border-gray-200 bg-white p-4" data-testid="mtc-photos">
      <h2 className="font-semibold">{t("mtc.photos")}</h2>
      <p className="mt-1 text-sm text-gray-600">{t("mtc.photos_intro")}</p>
      {pending.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500" data-testid="mtc-photos-none">
          {t("mtc.photos_none")}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-sm text-red-600" data-testid="mtc-photos-error">{error}</p>
      ) : null}
      {done ? (
        <p
          className={`mt-2 text-sm ${done.ok === done.total ? "text-green-700" : "text-amber-800"}`}
          data-testid="mtc-photos-done"
        >
          {done.ok === done.total
            ? t("mtc.photos_done", { count: done.ok })
            : t("mtc.photos_partial", { ok: done.ok, total: done.total, failed: done.total - done.ok })}
        </p>
      ) : null}
      {pending.length > 0 ? (
        <button
          type="button"
          className={`${btnPrimary} mt-3`}
          data-testid="mtc-photos-cta"
          disabled={busy}
          onClick={() => void upload()}
        >
          {busy ? t("mtc.photos_uploading") : t("mtc.photos_cta", { count: pending.length })}
        </button>
      ) : null}
    </section>
  );
}

export function MyTownCartScreen() {
  const dataVersion = useAppStore((s) => s.dataVersion);
  const bumpDataVersion = useAppStore((s) => s.bumpDataVersion);
  const sellerIsApproved = useAppStore((s) => s.sellerIsApproved);
  const setSellerIsApproved = useAppStore((s) => s.setSellerIsApproved);

  const [phase, setPhase] = useState<Phase>("boot");
  const [tab, setTab] = useState<"catalog" | "sync">("catalog");
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
      const token = await loadConnection();
      await loadLocal();
      if (token) {
        setPhase("connected");
        await loadRemote(token);
      } else {
        setPhase("disconnected");
      }
    })();
  }, [loadLocal, loadRemote]);

  useEffect(() => {
    void loadLocal();
  }, [dataVersion, loadLocal]);

  const planInputs = useMemo(() => toPlanInputs(items, categories), [items, categories]);
  const plan = useMemo(() => planPublish(planInputs, marketplace ?? []), [planInputs, marketplace]);

  const lastPublishedAt = useMemo(() => {
    const published = items.filter((i) => i.contentHash !== null);
    if (published.length === 0) return null;
    return published
      .map((i) => i.updatedAt)
      .sort((a, b) => b.localeCompare(a))[0] ?? null;
  }, [items]);

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
    <div className="max-w-3xl space-y-4" data-testid="mtc-screen">
      <h1 className="text-lg font-bold">{t("mtc.title")}</h1>

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
                ["catalog", "mtc.tab.catalog"],
                ["sync", "mtc.tab.sync"],
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

          {tab === "sync" ? <SyncPanel /> : null}

          {tab === "catalog" && marketplace === null ? (
            <p className="text-sm text-gray-500">{t("common.loading")}</p>
          ) : null}
          {tab === "catalog" && marketplace !== null ? (
            <>
              <CategoryMapping
                categories={categories}
                marketplace={marketplace}
                onSave={() => bumpDataVersion()}
              />
              <PublishPanel
                ready={plan.ready}
                blocked={plan.blocked}
                categories={categories}
                lastPublishedAt={lastPublishedAt}
                onPublished={() => void loadLocal()}
              />
              <PhotoPanel items={items} onDone={() => void loadLocal()} />
              <ReviewTable items={items} blocked={plan.blocked} />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Every item the seller cares about: what was published, and what blocks the rest. */
function ReviewTable({
  items,
  blocked,
}: {
  items: Item[];
  blocked: ReturnType<typeof planPublish>["blocked"];
}) {
  const reasonByItem = new Map(blocked.map((b) => [b.id, b.reason.code]));
  const rows = items.filter((i) => i.publishState !== "local_only" || reasonByItem.has(i.id));
  if (rows.length === 0) return null;
  return (
    <section className="rounded border border-gray-200 bg-white p-4" data-testid="mtc-states">
      <h2 className="font-semibold">{t("mtc.published_title")}</h2>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {rows.map((item) => {
            const reason = reasonByItem.get(item.id);
            const label = reason
              ? t(`mtc.blocked.${reason}` as I18nKey)
              : t(`mtc.state.${item.publishState}` as I18nKey);
            return (
              <tr key={item.id} className="border-t border-gray-100" data-testid={`mtc-state-${item.id}`}>
                <td className="py-1 font-medium">{item.name}</td>
                <td className="py-1 text-right">{formatPaise(item.pricePaise)}</td>
                <td className="py-1 pl-4 text-right text-gray-600">
                  {t("mtc.state_stock", { count: Math.trunc(item.stockMilli / 1000) })}
                </td>
                <td
                  className={`py-1 pl-4 text-right ${reason ? "text-amber-800" : "text-gray-700"}`}
                >
                  {label}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
