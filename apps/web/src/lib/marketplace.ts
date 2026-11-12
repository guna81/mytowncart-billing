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
  MyTownCartConnector,
} from "@mytowncart-billing/connector-mytowncart";
import { currentToken } from "./connection";
import { isLanServer } from "./repository";
import { lanMarketplaceFetch } from "./lanMarketplace";
import { variantSyncEnabled } from "./variantSync";

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const MARKETPLACE_WEB_URL = env.VITE_MTC_WEB_URL || DEFAULT_WEB_BASE_URL;

let connector: MyTownCartConnector | null = null;

export function getConnector(): MyTownCartConnector {
  if (!connector) {
    connector = new MyTownCartConnector({
      apiBaseUrl: env.VITE_MTC_API_URL || DEFAULT_API_BASE_URL,
      webBaseUrl: MARKETPLACE_WEB_URL,
      appVersion: APP_VERSION,
      variantGroups: variantSyncEnabled(),
      getToken: currentToken,
      ...(isLanServer() ? { fetch: lanMarketplaceFetch } : {}),
    });
  }
  return connector;
}
