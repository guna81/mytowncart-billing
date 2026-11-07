// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DOWNLOAD_PAGE_URL, openDownloadPage, openReleasePage } from "./tauri";

describe("tauri - openReleasePage / openDownloadPage", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it("has the expected download page URL", () => {
    expect(DOWNLOAD_PAGE_URL).toBe("https://guna81.github.io/mytowncart-billing/#download");
  });

  it("opens DOWNLOAD_PAGE_URL in a new browser tab when not in Tauri", async () => {
    const openMock = vi.fn();
    globalThis.window = { open: openMock } as unknown as Window & typeof globalThis;

    await openReleasePage();
    expect(openMock).toHaveBeenCalledWith(
      "https://guna81.github.io/mytowncart-billing/#download",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("opens custom URL if passed when not in Tauri", async () => {
    const openMock = vi.fn();
    globalThis.window = { open: openMock } as unknown as Window & typeof globalThis;

    await openReleasePage("https://example.com");
    expect(openMock).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("openDownloadPage is an alias for openReleasePage", async () => {
    const openMock = vi.fn();
    globalThis.window = { open: openMock } as unknown as Window & typeof globalThis;

    await openDownloadPage();
    expect(openMock).toHaveBeenCalledWith(
      "https://guna81.github.io/mytowncart-billing/#download",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("safely handles environments without window", async () => {
    // @ts-expect-error simulating non-browser environment
    delete globalThis.window;
    await expect(openReleasePage()).resolves.toBeUndefined();
  });
});
