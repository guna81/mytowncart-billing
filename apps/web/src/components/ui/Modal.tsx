// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, type ReactNode } from "react";

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  maxWidth = "max-w-md",
  testId = "modal",
  dataTestId,
  hideCloseButton = false,
  closable = true,
}: {
  isOpen: boolean;
  onClose(): void;
  title?: ReactNode;
  children: ReactNode;
  maxWidth?: string;
  testId?: string;
  dataTestId?: string;
  hideCloseButton?: boolean;
  closable?: boolean;
}) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen || !closable) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose, closable]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 transition-opacity"
      onMouseDown={(e) => {
        if (closable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        data-testid={dataTestId ?? testId}
        className={`w-full ${maxWidth} rounded-xl bg-white p-5 shadow-2xl transition-all border border-gray-100 flex flex-col max-h-[90vh]`}
      >
        {title ? (
          <div className="flex items-center justify-between pb-3 border-b border-gray-200 mb-4">
            <h2 className="text-base font-bold text-gray-900">{title}</h2>
            {!hideCloseButton && closable ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                aria-label="Close"
              >
                ✕
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
