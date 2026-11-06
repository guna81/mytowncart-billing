// SPDX-License-Identifier: Apache-2.0
import { useEffect } from "react";
import { t } from "../i18n";

interface ShortcutItem {
  keyCombo: string;
  action: string;
  scope: string;
}

const SHORTCUTS: ShortcutItem[] = [
  { keyCombo: "F1 or ?", action: "Open / Close this Keyboard Cheat Sheet", scope: "Global" },
  { keyCombo: "F2", action: "Focus Barcode / Item Search Bar", scope: "POS Billing" },
  { keyCombo: "F4", action: "Quick Exact Cash & Complete Bill", scope: "POS Billing" },
  { keyCombo: "F7", action: "Park (Hold) Current Cart for Later", scope: "POS Billing" },
  { keyCombo: "F9", action: "Switch to Split Payment Mode", scope: "POS Billing" },
  { keyCombo: "Enter", action: "Select Highlighted Search Suggestion", scope: "POS Billing" },
  { keyCombo: "Esc", action: "Dismiss Dialog / Close Modal", scope: "Global" },
];

export function KeyboardShortcutsModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose(): void;
}) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4"
      data-testid="keyboard-shortcuts-modal"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 pb-3">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-100 text-blue-700 text-sm font-bold">
              ⌨
            </span>
            <h2 className="text-base font-bold text-gray-900">
              Keyboard Shortcuts & Operator Help
            </h2>
          </div>
          <button
            type="button"
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            data-testid="shortcuts-modal-close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <p className="mt-2 text-xs text-gray-500">
          Fast-lane billing keys designed for high-speed cash counter operations:
        </p>

        <div className="mt-4 divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-100 bg-gray-50/50">
          {SHORTCUTS.map((s, idx) => (
            <div key={idx} className="flex items-center justify-between p-3 text-xs">
              <div>
                <span className="font-medium text-gray-800">{s.action}</span>
                <span className="ml-2 text-[10px] uppercase font-bold text-gray-400">
                  {s.scope}
                </span>
              </div>
              <kbd className="rounded-md border border-gray-300 bg-white px-2 py-1 font-mono text-[11px] font-bold text-gray-700 shadow-2xs">
                {s.keyCombo}
              </kbd>
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 shadow-sm"
            onClick={onClose}
          >
            Got it (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}
