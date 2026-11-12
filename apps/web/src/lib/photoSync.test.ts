// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { imageHash } from "@mytowncart-billing/core";
import type { MarketplaceConnector, RemoteItem } from "@mytowncart-billing/connector-mytowncart";
import { MemoryRepository } from "@mytowncart-billing/storage";

import { decidePhotoAction, syncPhotos } from "./photoSync";

const local = (hash: string, createdAt = "2026-11-10T10:00:00+05:30", uploadedAt: string | null = null) => ({
  hash,
  createdAt,
  uploadedAt,
});

describe("decidePhotoAction", () => {
  it("fills a missing local photo from MyTownCart", () => {
    expect(decidePhotoAction({ remoteId: "r1", remoteAt: null, local: null, seen: undefined })).toBe("pull");
  });
  it("only records on the first look", () => {
    expect(decidePhotoAction({ remoteId: "r1", remoteAt: null, local: local("h1"), seen: undefined })).toBe("none");
  });
  it("pulls when only MyTownCart changed, pushes when only this app changed", () => {
    const seen = { r: "r1", l: "h1" };
    expect(decidePhotoAction({ remoteId: "r2", remoteAt: null, local: local("h1"), seen })).toBe("pull");
    expect(decidePhotoAction({ remoteId: "r1", remoteAt: null, local: local("h2"), seen })).toBe("push");
    expect(decidePhotoAction({ remoteId: "r1", remoteAt: null, local: local("h1"), seen })).toBe("none");
  });
  it("when both changed, the later change wins", () => {
    const seen = { r: "r1", l: "h1" };
    const remoteNewer = decidePhotoAction({
      remoteId: "r2",
      remoteAt: "2026-11-11T12:00:00+05:30",
      local: local("h2", "2026-11-10T10:00:00+05:30"),
      seen,
    });
    const localNewer = decidePhotoAction({
      remoteId: "r2",
      remoteAt: "2026-11-09T12:00:00+05:30",
      local: local("h2", "2026-11-10T10:00:00+05:30"),
      seen,
    });
    expect(remoteNewer).toBe("pull");
    expect(localNewer).toBe("push");
  });
  it("does not pull back a photo this app already sent", () => {
    const seen = { r: "r1", l: "h1" };
    const out = decidePhotoAction({
      remoteId: "r2",
      remoteAt: "2026-11-10T10:00:30+05:30", // seconds after our own upload
      local: local("h2", "2026-11-10T09:00:00+05:30", "2026-11-10T10:00:40+05:30"),
      seen,
    });
    expect(out).toBe("none");
  });
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const JPEG2 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);

async function setup() {
  const repo = new MemoryRepository();
  const itemId = await repo.upsertItem({
    name: "Tea", barcode: "", categoryId: null, unitKind: "count", pricePaise: 1000, mrpPaise: 1000,
    taxRateBp: 0, openingStockMilli: 0, isActive: true,
  });
  const uploads: string[] = [];
  let download: Uint8Array = JPEG;
  const connector = {
    downloadImage: () => Promise.resolve(download),
    uploadImage: (externalId: string) => {
      uploads.push(externalId);
      return Promise.resolve({ imageId: "new-remote" });
    },
  } as unknown as MarketplaceConnector;
  const remote = (id: string | null, at = "2026-11-11T10:00:00+05:30"): RemoteItem => ({
    externalId: `itm_${itemId}`,
    productId: "p1",
    variantId: "v1",
    stockUnits: 0,
    pricePaise: 1000,
    isActive: true,
    mainImage: id === null ? null : { id, url: "https://media.example/p.webp", uploadedAt: at },
  });
  const run = (r: RemoteItem) => syncPhotos(repo, connector, [r], (ext) => (ext === `itm_${itemId}` ? itemId : null));
  return { repo, itemId, uploads, run, remote, setDownload: (b: Uint8Array) => (download = b) };
}

describe("syncPhotos", () => {
  it("downloads a photo this app lacks, and never sends it back", async () => {
    const { repo, itemId, uploads, run, remote } = await setup();
    const out = await run(remote("r1"));
    expect(out.pulled).toBe(1);
    const images = await repo.listItemImages(itemId);
    expect(images).toHaveLength(1);
    expect(images[0]?.isMain).toBe(true);
    expect(images[0]?.imageUploadedAt).not.toBeNull();
    expect((await run(remote("r1"))).pulled).toBe(0); // nothing new
    expect(uploads).toHaveLength(0);
  });

  it("takes a photo replaced on MyTownCart when this app didn't change its own", async () => {
    const { repo, itemId, run, remote, setDownload } = await setup();
    await run(remote("r1"));
    setDownload(JPEG2);
    const out = await run(remote("r2"));
    expect(out.pulled).toBe(1);
    const main = (await repo.listItemImages(itemId)).find((i) => i.isMain);
    expect(main?.imageHash).toBe(await imageHash(JPEG2));
  });

  it("sends a photo changed here when MyTownCart didn't change", async () => {
    const { repo, itemId, uploads, run, remote } = await setup();
    await run(remote("r1")); // baseline = r1 / hash of JPEG
    await repo.addItemImage(itemId, JPEG2, (await imageHash(JPEG2))!, true);
    const out = await run(remote("r1"));
    expect(out.pushed).toBe(1);
    expect(uploads).toHaveLength(1);
  });

  it("skips an older server that doesn't report the main photo", async () => {
    const { run, remote } = await setup();
    const r = remote("r1");
    delete r.mainImage;
    expect(await run(r)).toEqual({ pulled: 0, pushed: 0, problems: [] });
  });

  it("reports a bad download instead of failing the sync", async () => {
    const { run, remote, setDownload } = await setup();
    setDownload(new Uint8Array([1, 2, 3]));
    const out = await run(remote("r1"));
    expect(out.pulled).toBe(0);
    expect(out.problems).toHaveLength(1);
  });
});
