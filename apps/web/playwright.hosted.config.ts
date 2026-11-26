// SPDX-License-Identifier: Apache-2.0
/** E2E for the hosted web app build (VITE_HOSTED=1, D13) against a mocked MyTownCart API. */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-hosted",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:5180",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev --port 5180",
    env: { VITE_HOSTED: "1" },
    url: "http://localhost:5180",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
