// SPDX-License-Identifier: Apache-2.0
/**
 * Main-photo sync between this app and MyTownCart: the most recently changed
 * photo wins, and the other side is updated to match.
 *
 * Per linked item we remember what each side's main photo was at the last look
 * (the remote photo id and the local image hash; ids and hashes only, no
 * images). Comparing against that tells which side changed:
 *  - only MyTownCart changed (or this app has no photo)  → download it here;
 *  - only this app changed                              → upload it there;
 *  - both changed                                       → the later change wins.
 * A first look only records. An older server that doesn't report `mainImage`
 * is skipped entirely.
 */
import { IMAGE_MIME, imageHash, localIsoTimestamp, sniffImage } from "@mytowncart-billing/core";
import type { BillingRepository, ItemImage } from "@mytowncart-billing/storage";
import type { MarketplaceConnector, RemoteItem } from "@mytowncart-billing/connector-mytowncart";

type Baseline = Record<string, { r: string | null; l: string | null }>;
const PHOTO_BASELINE_KEY = "sync.photo_baseline";

/** Clock slack when comparing our own upload time with the server's. */
const SKEW_MS = 2 * 60 * 1000;

export interface PhotoSyncResult {
  pulled: number;
  pushed: number;
  problems: string[];
}

async function loadBaseline(repo: BillingRepository): Promise<Baseline> {
  try {
    return JSON.parse((await repo.getAppSetting(PHOTO_BASELINE_KEY)) ?? "{}") as Baseline;
  } catch {
    return {};
  }
}

function mainOf(images: readonly ItemImage[]): ItemImage | null {
  return images.find((i) => i.isMain) ?? images[0] ?? null;
}

export function decidePhotoAction(input: {
  remoteId: string | null;
  remoteAt: string | null;
  local: { hash: string; createdAt: string; uploadedAt: string | null } | null;
  seen: { r: string | null; l: string | null } | undefined;
}): "pull" | "push" | "none" {
  const { remoteId, remoteAt, local, seen } = input;
  if (remoteId !== null && local === null) return "pull";
  if (remoteId === null && local !== null) return "none"; // the normal upload step sends it
  if (remoteId === null || local === null) return "none";
  if (seen === undefined) return "none"; // first look: record only
  const remoteChanged = seen.r !== remoteId;
  const localChanged = seen.l !== local.hash;
  if (remoteChanged && !localChanged) return "pull";
  if (localChanged && !remoteChanged) return local.uploadedAt === null ? "push" : "none";
  if (!remoteChanged && !localChanged) return "none";
  // Both changed since the last look.
  const remoteTime = remoteAt === null ? NaN : Date.parse(remoteAt);
  if (local.uploadedAt !== null) {
    // Our photo was already sent; the remote one is only newer if it came after that.
    return Number.isFinite(remoteTime) && remoteTime > Date.parse(local.uploadedAt) + SKEW_MS ? "pull" : "none";
  }
  const localTime = Date.parse(local.createdAt);
  if (!Number.isFinite(remoteTime) || !Number.isFinite(localTime)) return "push"; // can't tell: this app wins
  return remoteTime > localTime ? "pull" : "push";
}

export async function syncPhotos(
  repo: BillingRepository,
  connector: MarketplaceConnector,
  remote: readonly RemoteItem[],
  itemIdOf: (externalId: string, remoteProductId: string) => number | null,
): Promise<PhotoSyncResult> {
  const result: PhotoSyncResult = { pulled: 0, pushed: 0, problems: [] };
  if (!remote.some((r) => r.mainImage !== undefined)) return result; // older server
  const baseline = await loadBaseline(repo);
  const next: Baseline = { ...baseline };

  for (const r of remote) {
    if (r.mainImage === undefined) continue;
    const itemId = itemIdOf(r.externalId, r.productId);
    if (itemId === null) continue;
    try {
      const images = await repo.listItemImages(itemId);
      const main = mainOf(images);
      const remoteMain = r.mainImage;
      const action = decidePhotoAction({
        remoteId: remoteMain?.id ?? null,
        remoteAt: remoteMain?.uploadedAt ?? null,
        local: main ? { hash: main.imageHash, createdAt: main.createdAt, uploadedAt: main.imageUploadedAt } : null,
        seen: baseline[r.externalId],
      });

      if (action === "pull" && remoteMain && connector.downloadImage) {
        const bytes = await connector.downloadImage(remoteMain.url);
        const hash = await imageHash(bytes);
        if (sniffImage(bytes) === null || hash === null) throw new Error("not a usable image");
        if (!images.some((i) => i.imageHash === hash)) {
          await repo.addItemImage(itemId, bytes, hash, true);
        }
        // It came from MyTownCart: never send it back.
        await repo.recordImageUploads([{ itemId, imageHash: hash, uploadedAt: localIsoTimestamp(new Date()) }]);
        next[r.externalId] = { r: remoteMain.id, l: hash };
        result.pulled += 1;
        continue;
      }

      if (action === "push" && main) {
        const photo = await repo.readItemImage(main.id);
        if (photo && photo.imageHash === main.imageHash) {
          const blob = new Blob([photo.bytes as BlobPart], { type: IMAGE_MIME[sniffImage(photo.bytes) ?? "jpeg"] });
          const sent = await connector.uploadImage(r.externalId, blob, true);
          await repo.recordImageUploads([
            { itemId, imageHash: main.imageHash, uploadedAt: localIsoTimestamp(new Date()) },
          ]);
          const sentId = sent && typeof sent === "object" ? sent.imageId : undefined;
          if (sentId) {
            next[r.externalId] = { r: sentId, l: main.imageHash };
            result.pushed += 1;
            continue;
          }
          // The server didn't say which photo this became: look again next time.
          continue;
        }
      }

      next[r.externalId] = { r: remoteMain?.id ?? null, l: main?.imageHash ?? null };
    } catch (err) {
      result.problems.push(`photo ${r.name ?? r.externalId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await repo.setAppSetting(PHOTO_BASELINE_KEY, JSON.stringify(next));
  return result;
}
