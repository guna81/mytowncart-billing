// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { generateUpiUri, type UpiPayload } from "@mytowncart-billing/core";

interface Props extends UpiPayload {
  size?: number;
  className?: string;
}

export function UpiQrCode({ vpa, payeeName, amountPaise, transactionNote, transactionRef, size = 160, className = "" }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vpa || !vpa.trim() || amountPaise <= 0) {
      setDataUrl(null);
      return;
    }

    try {
      const uri = generateUpiUri({
        vpa,
        payeeName,
        amountPaise,
        transactionNote,
        transactionRef,
      });

      QRCode.toDataURL(uri, {
        width: size,
        margin: 1,
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
      })
        .then((url) => {
          setDataUrl(url);
          setError(null);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
          setDataUrl(null);
        });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDataUrl(null);
    }
  }, [vpa, payeeName, amountPaise, transactionNote, transactionRef, size]);

  if (error) {
    return <div className="text-xs text-red-500">{error}</div>;
  }

  if (!dataUrl) {
    return null;
  }

  return (
    <div className={`flex flex-col items-center ${className}`} data-testid="upi-qr-code">
      <img
        src={dataUrl}
        alt="UPI QR Code"
        width={size}
        height={size}
        className="rounded border border-gray-200 bg-white p-1"
      />
      <div className="mt-1 text-center font-mono text-[11px] text-gray-600">
        Scan to pay with any UPI App
      </div>
    </div>
  );
}
