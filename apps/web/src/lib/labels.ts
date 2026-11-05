// SPDX-License-Identifier: Apache-2.0
import type { PaymentMode } from "@mytowncart-billing/core";
import { t, type I18nKey } from "../i18n";

export function paymentModeLabel(mode: PaymentMode): string {
  return t(`pos.mode.${mode}` as I18nKey);
}
