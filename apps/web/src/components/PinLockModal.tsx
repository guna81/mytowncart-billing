// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type FormEvent } from "react";
import type { User, UserRole } from "@mytowncart-billing/storage";
import { Button, Modal } from "./ui";
import { t } from "../i18n";
import { getRepository } from "../lib/repository";
import { useAppStore } from "../store/appStore";

interface Props {
  isOpen: boolean;
  onClose?: () => void;
  onSuccess: (user: User) => void;
  requiredRole?: UserRole;
  title?: string;
  prompt?: string;
  isQuickLock?: boolean;
}

export function PinLockModal({
  isOpen,
  onClose,
  onSuccess,
  requiredRole,
  title,
  prompt,
  isQuickLock = false,
}: Props) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [hasUsers, setHasUsers] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getRepository()
      .listUsers()
      .then((users) => {
        if (cancelled) return;
        const valid = users.filter((u) => u.isActive && u.hasPin);
        setHasUsers(valid.length > 0);
      })
      .catch(() => {
        if (!cancelled) setHasUsers(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!pin.trim()) return;

    try {
      setVerifying(true);
      setError(null);
      const user = await getRepository().verifyPin(pin.trim(), requiredRole);
      if (!user) {
        setError(t("users.invalid_pin"));
        setPin("");
        return;
      }
      setPin("");
      onSuccess(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPin("");
    } finally {
      setVerifying(false);
    }
  };

  const handleDigit = (d: string) => {
    if (pin.length < 6) {
      const next = pin + d;
      setPin(next);
      if (next.length === 4) {
        // Auto-check on 4 digits
        setTimeout(() => {
          void (async () => {
            try {
              const u = await getRepository().verifyPin(next, requiredRole);
              if (u) {
                setPin("");
                onSuccess(u);
              }
            } catch {
              // Ignore background verify
            }
          })();
        }, 100);
      }
    }
  };

  // If locked but no users exist in the system, allow closing/dismissing
  const canDismiss = !isQuickLock || hasUsers === false;
  const handleDismiss = () => {
    if (onClose) {
      try {
        onClose();
      } catch (err) {
        console.error("onClose failed:", err);
      }
    }
    if (isQuickLock) {
      useAppStore.getState().setIsLocked(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleDismiss}
      closable={canDismiss}
      hideCloseButton={!canDismiss}
      title={title ?? (isQuickLock ? t("users.locked") : t("users.supervisor_title"))}
      maxWidth="max-w-xs"
      dataTestId="pin-lock-modal"
    >
      {hasUsers === false ? (
        <div className="space-y-4 py-2 text-center">
          <p className="text-xs text-amber-700 bg-amber-50 p-2.5 rounded-lg border border-amber-200">
            {t("users.lock_no_users_msg")}
          </p>
          <div className="pt-2 flex justify-center">
            <Button variant="primary" type="button" onClick={handleDismiss}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <p className="text-center text-xs text-gray-500">
            {prompt ?? (isQuickLock ? "Enter PIN to unlock terminal" : t("users.supervisor_prompt"))}
          </p>

          <div className="flex justify-center">
            <input
              type="password"
              autoFocus
              maxLength={6}
              data-testid="pin-input"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-40 text-center tracking-[0.5em] text-2xl font-mono font-bold rounded-lg border-2 border-gray-300 py-2 focus:border-blue-500 focus:outline-none"
              placeholder="••••"
            />
          </div>

          {/* Numeric PIN Keypad */}
          <div className="grid grid-cols-3 gap-2 px-4">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <button
                key={n}
                type="button"
                className="h-11 rounded-lg border border-gray-200 bg-gray-50 text-base font-semibold text-gray-800 hover:bg-gray-100 active:bg-gray-200"
                onClick={() => handleDigit(String(n))}
              >
                {n}
              </button>
            ))}
            <button
              type="button"
              className="h-11 rounded-lg border border-gray-200 bg-gray-50 text-xs font-medium text-gray-500 hover:bg-gray-100"
              onClick={() => setPin("")}
            >
              Clear
            </button>
            <button
              type="button"
              className="h-11 rounded-lg border border-gray-200 bg-gray-50 text-base font-semibold text-gray-800 hover:bg-gray-100 active:bg-gray-200"
              onClick={() => handleDigit("0")}
            >
              0
            </button>
            <button
              type="button"
              className="h-11 rounded-lg border border-gray-200 bg-gray-50 text-xs font-medium text-gray-500 hover:bg-gray-100"
              onClick={() => setPin((p) => p.slice(0, -1))}
            >
              ⌫
            </button>
          </div>

          {error ? (
            <p className="text-center text-xs font-medium text-red-600 bg-red-50 p-1.5 rounded">
              {error}
            </p>
          ) : null}

          <div className="flex justify-between items-center pt-2">
            {!isQuickLock && onClose ? (
              <Button variant="secondary" type="button" onClick={onClose}>
                {t("common.cancel")}
              </Button>
            ) : <div />}
            <Button
              variant="primary"
              type="submit"
              data-testid="pin-submit"
              disabled={verifying || pin.length < 4}
            >
              {verifying ? t("common.saving") : t("users.unlock")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
