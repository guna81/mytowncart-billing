// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { generateUpiUri, generateWhatsAppBillShareUrl } from "../src/upi";

describe("generateUpiUri", () => {
  it("generates NPCI valid standard UPI pay URI", () => {
    const uri = generateUpiUri({
      vpa: "mytowncart@icici",
      payeeName: "Guna Supermarket",
      amountPaise: 12550,
      transactionNote: "INV-2026-0001",
    });

    expect(uri).toBe(
      "upi://pay?pa=mytowncart%40icici&pn=Guna+Supermarket&am=125.50&cu=INR&tn=INV-2026-0001",
    );
  });

  it("throws if VPA is missing or whitespace", () => {
    expect(() =>
      generateUpiUri({
        vpa: "   ",
        payeeName: "Store",
        amountPaise: 100,
      }),
    ).toThrow("UPI VPA is required");
  });
});

describe("generateWhatsAppBillShareUrl", () => {
  it("formats Indian phone number with country code 91", () => {
    const url = generateWhatsAppBillShareUrl("9876543210", "Bill INV-001 total ₹100");
    expect(url).toBe("https://wa.me/919876543210?text=Bill%20INV-001%20total%20%E2%82%B9100");
  });

  it("handles numbers already starting with country code", () => {
    const url = generateWhatsAppBillShareUrl("+919876543210", "Hello");
    expect(url).toBe("https://wa.me/919876543210?text=Hello");
  });
});
