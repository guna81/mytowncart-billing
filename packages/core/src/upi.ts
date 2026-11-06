// SPDX-License-Identifier: Apache-2.0
/**
 * NPCI UPI dynamic QR URI generation and WhatsApp bill sharing.
 */

export interface UpiPayload {
  vpa: string;
  payeeName: string;
  amountPaise: number;
  transactionNote?: string;
  transactionRef?: string;
}

export function generateUpiUri(payload: UpiPayload): string {
  if (!payload.vpa.trim()) {
    throw new Error("UPI VPA is required");
  }
  const params = new URLSearchParams();
  params.set("pa", payload.vpa.trim());
  params.set("pn", payload.payeeName.trim() || "Store");
  params.set("am", (payload.amountPaise / 100).toFixed(2));
  params.set("cu", "INR");
  if (payload.transactionNote) {
    params.set("tn", payload.transactionNote.trim());
  }
  if (payload.transactionRef) {
    params.set("tr", payload.transactionRef.trim());
  }
  return `upi://pay?${params.toString()}`;
}

export function generateWhatsAppBillShareUrl(phone: string, message: string): string {
  const cleanPhone = phone.replace(/[^0-9]/g, "");
  const fullPhone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
  return `https://wa.me/${fullPhone}?text=${encodeURIComponent(message)}`;
}
