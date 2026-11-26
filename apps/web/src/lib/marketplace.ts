// SPDX-License-Identifier: Apache-2.0
/**
 * The marketplace connector singleton. Endpoints default to production; a
 * developer can point a browser-only build at a local backend with
 * `VITE_MTC_WEB_URL` / `VITE_MTC_API_URL` (never at runtime in a shipped app).
 */
import { APP_VERSION } from "@mytowncart-billing/core";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_WEB_BASE_URL,
  DEV_API_BASE_URL,
  DEV_WEB_BASE_URL,
  MyTownCartConnector,
} from "@mytowncart-billing/connector-mytowncart";
import { currentToken } from "./connection";
import { isHosted } from "./hosted/mode";
import { refreshHostedToken } from "./hosted/oauth";
import { isLanServer } from "./repository";
import { lanMarketplaceFetch } from "./lanMarketplace";
import { variantSyncEnabled } from "./variantSync";

const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};
const isDev = Boolean(env.DEV);

export const MARKETPLACE_WEB_URL =
  (typeof env.VITE_MTC_WEB_URL === "string" && env.VITE_MTC_WEB_URL
    ? env.VITE_MTC_WEB_URL
    : isDev
      ? DEV_WEB_BASE_URL
      : DEFAULT_WEB_BASE_URL);

export const MARKETPLACE_API_URL =
  (typeof env.VITE_MTC_API_URL === "string" && env.VITE_MTC_API_URL
    ? env.VITE_MTC_API_URL
    : isDev
      ? DEV_API_BASE_URL
      : DEFAULT_API_BASE_URL);

let connector: MyTownCartConnector | null = null;

export function getConnector(): MyTownCartConnector {
  if (!connector) {
    connector = new MyTownCartConnector({
      apiBaseUrl: MARKETPLACE_API_URL,
      webBaseUrl: MARKETPLACE_WEB_URL,
      appVersion: APP_VERSION,
      variantGroups: variantSyncEnabled(),
      getToken: currentToken,
      ...(isHosted() ? { onUnauthorized: refreshHostedToken } : {}),
      ...(isLanServer() ? { fetch: lanMarketplaceFetch } : {}),
    });
  }
  return connector;
}
