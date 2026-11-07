// SPDX-License-Identifier: Apache-2.0
/**
 * The current PIN-login session. The token is kept in memory only (never
 * persisted) and is sent with sensitive commands so the Rust shell can enforce
 * roles. The UI mirrors the policy, but Rust is what actually decides.
 */

let token: string | null = null;

export function getSessionToken(): string | null {
  return token;
}

export function setSessionToken(next: string | null): void {
  token = next;
}

/** Commands that Rust gates on a session (kept in step with `auth::required_role`). */
export const SESSION_GATED_COMMANDS: ReadonlySet<string> = new Set([
  "void_bill",
  "adjust_stock",
  "create_credit_note",
  "apply_stock_audit",
  "upsert_user",
  "create_purchase",
  "upsert_item",
  "import_items",
  "delete_customer",
  "upsert_supplier",
  "delete_supplier",
  "save_shop_profile",
  "list_audit_logs",
]);
