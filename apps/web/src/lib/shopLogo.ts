// SPDX-License-Identifier: Apache-2.0

export const SHOP_LOGO_KEY = "shop.logo";
export const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/svg+xml",
]);

export interface ProcessLogoResult {
  ok: boolean;
  dataUrl?: string;
  error?: "too_large" | "invalid_type" | "read_failed";
}

/**
 * Validates and processes a logo image file, converting it to a data URL.
 * Scales large raster images down to a maximum bounding box of 512x512
 * to ensure fast rendering and low storage footprint.
 */
export async function processLogoFile(file: File): Promise<ProcessLogoResult> {
  if (file.size > MAX_LOGO_BYTES) {
    return { ok: false, error: "too_large" };
  }

  const type = file.type?.toLowerCase();
  const name = file.name?.toLowerCase() || "";
  const isAllowedExt =
    name.endsWith(".png") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".webp") ||
    name.endsWith(".svg");

  if (!ALLOWED_MIME_TYPES.has(type) && !isAllowedExt) {
    return { ok: false, error: "invalid_type" };
  }

  const rawDataUrl = await readFileAsDataUrl(file);
  if (!rawDataUrl) {
    return { ok: false, error: "read_failed" };
  }

  // SVGs are vector and keep their original data URL
  if (type === "image/svg+xml" || name.endsWith(".svg")) {
    return { ok: true, dataUrl: rawDataUrl };
  }

  // Attempt raster downscale to max 512px if in browser environment
  try {
    const resized = await resizeRasterImage(rawDataUrl, 512);
    return { ok: true, dataUrl: resized };
  } catch {
    // If canvas is unavailable (e.g. node / happy-dom), fallback to rawDataUrl
    return { ok: true, dataUrl: rawDataUrl };
  }
}

async function readFileAsDataUrl(file: File): Promise<string | null> {
  try {
    if (typeof FileReader !== "undefined") {
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          resolve(typeof reader.result === "string" ? reader.result : null);
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }

    // Node / test environment fallback
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mime = file.type || "image/png";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

function resizeRasterImage(dataUrl: string, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return reject(new Error("DOM not available"));
    }

    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width <= maxDim && height <= maxDim) {
        return resolve(dataUrl);
      }

      if (width > height) {
        height = Math.round((height * maxDim) / width);
        width = maxDim;
      } else {
        width = Math.round((width * maxDim) / height);
        height = maxDim;
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return resolve(dataUrl);
      }

      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = dataUrl;
  });
}
