// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { computeCreditNote, formatQty } from "@mytowncart-billing/core";
import type { BillDetail } from "@mytowncart-billing/storage";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";
import { Button, Modal, Money } from "./ui";

interface Props {
  bill: BillDetail;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (creditNoteId: number, number: string) => void;
}

export function CreditNoteModal({ bill, isOpen, onClose, onSuccess }: Props) {
  const profile = useAppStore((s) => s.profile);
  const [returnQtys, setReturnQtys] = useState<Record<number, number>>({});
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pricesIncludeTax = profile?.pricesIncludeTax ?? true;

  const handleQtyChange = (lineId: number, maxMilli: number, qtyMilli: number) => {
    const clamped = Math.max(0, Math.min(maxMilli, qtyMilli));
    setReturnQtys((prev) => ({
      ...prev,
      [lineId]: clamped,
    }));
  };

  const linesToReturn = bill.lines
    .filter((l) => (returnQtys[l.id] ?? 0) > 0)
    .map((l) => ({
      itemId: l.itemId ?? 0,
      name: l.nameSnapshot,
      qtyMilli: returnQtys[l.id]!,
      unitPricePaise: l.unitPricePaise,
      taxRateBp: l.taxRateBp,
      hsnCode: l.hsnCode,
    }));

  let computed;
  try {
    if (linesToReturn.length > 0 && reason.trim()) {
      computed = computeCreditNote(bill.id, reason.trim(), linesToReturn, { pricesIncludeTax });
    }
  } catch {
    computed = undefined;
  }

  const handleSubmit = async () => {
    if (linesToReturn.length === 0) {
      setError("Please select at least one item to return with quantity > 0");
      return;
    }
    if (!reason.trim()) {
      setError("Please provide a return reason");
      return;
    }

    try {
      setSubmitting(true);
      setError(null);
      const computedNote = computeCreditNote(bill.id, reason.trim(), linesToReturn, { pricesIncludeTax });

      const res = await getRepository().createCreditNote({
        billId: bill.id,
        reason: reason.trim(),
        createdAt: new Date().toISOString(),
        lines: computedNote.lines.map((l) => ({
          itemId: l.itemId,
          nameSnapshot: l.name,
          qtyMilli: l.qtyMilli,
          unitPricePaise: l.unitPricePaise,
          taxRateBp: l.taxRateBp,
          taxPaise: l.taxPaise,
          totalPaise: l.totalPaise,
          hsnCode: l.hsnCode,
        })),
      });

      onSuccess(res.creditNoteId, res.number);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t("returns.title")}
      maxWidth="max-w-2xl"
      dataTestId="credit-note-modal"
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          Select the items and quantities to return from bill{" "}
          <span className="font-semibold text-gray-800">{bill.number}</span>. Returned items will be
          credited back to stock.
        </p>

        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 text-left text-gray-600 font-medium">
              <tr>
                <th className="px-3 py-2">{t("returns.item")}</th>
                <th className="px-3 py-2 text-right">{t("common.price")}</th>
                <th className="px-3 py-2 text-right">{t("returns.billed_qty")}</th>
                <th className="px-3 py-2 text-center">{t("returns.return_qty")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {bill.lines.map((l) => {
                const currentQty = returnQtys[l.id] ?? 0;
                return (
                  <tr key={l.id} className={currentQty > 0 ? "bg-amber-50/50" : ""}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-800">{l.nameSnapshot}</div>
                      {l.hsnCode ? (
                        <div className="text-xs text-gray-600 font-mono">HSN: {l.hsnCode}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700">
                      <Money paise={l.unitPricePaise} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-600">
                      {formatQty(l.qtyMilli)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          className="w-7 h-7 flex items-center justify-center rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                          disabled={currentQty <= 0}
                          onClick={() => handleQtyChange(l.id, l.qtyMilli, currentQty - 1000)}
                        >
                          −
                        </button>
                        <input
                          type="number"
                          step="1"
                          min="0"
                          max={l.qtyMilli / 1000}
                          data-testid={`return-qty-${l.id}`}
                          value={currentQty / 1000}
                          onChange={(e) =>
                            handleQtyChange(
                              l.id,
                              l.qtyMilli,
                              Math.round(parseFloat(e.target.value || "0") * 1000),
                            )
                          }
                          className="w-16 text-center rounded border border-gray-300 py-1 text-sm font-semibold"
                        />
                        <button
                          type="button"
                          className="w-7 h-7 flex items-center justify-center rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                          disabled={currentQty >= l.qtyMilli}
                          onClick={() => handleQtyChange(l.id, l.qtyMilli, currentQty + 1000)}
                        >
                          +
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t("returns.reason")} <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            data-testid="return-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("returns.reason_ph")}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        {error ? <p className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</p> : null}

        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          <div>
            <span className="text-xs text-gray-500">{t("returns.credit_amount")}: </span>
            <span className="text-lg font-bold text-gray-900" data-testid="return-total">
              <Money paise={computed?.totalPaise ?? 0} />
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              data-testid="return-submit"
              disabled={submitting || linesToReturn.length === 0 || !reason.trim()}
              onClick={() => void handleSubmit()}
            >
              {submitting ? t("common.saving") : t("returns.confirm")}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
