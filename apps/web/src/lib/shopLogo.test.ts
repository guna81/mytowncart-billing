// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { processLogoFile, MAX_LOGO_BYTES, SHOP_LOGO_KEY } from "./shopLogo";

describe("shopLogo", () => {
  it("defines SHOP_LOGO_KEY as shop.logo", () => {
    expect(SHOP_LOGO_KEY).toBe("shop.logo");
  });

  it("rejects files exceeding MAX_LOGO_BYTES", async () => {
    const bigFile = new File([new Uint8Array(MAX_LOGO_BYTES + 10)], "big.png", {
      type: "image/png",
    });
    const result = await processLogoFile(bigFile);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("too_large");
  });

  it("rejects non-image file types", async () => {
    const pdfFile = new File([new Uint8Array(100)], "doc.pdf", {
      type: "application/pdf",
    });
    const result = await processLogoFile(pdfFile);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_type");
  });

  it("accepts valid png and svg files", async () => {
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
    const svgFile = new File([svgContent], "logo.svg", {
      type: "image/svg+xml",
    });
    const result = await processLogoFile(svgFile);
    expect(result.ok).toBe(true);
    expect(result.dataUrl).toContain("data:image/svg+xml");
  });
});
