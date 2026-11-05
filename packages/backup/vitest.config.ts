// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

// Node 18+ already provides WebCrypto as `globalThis.crypto`; this file only
// documents the dependency for readers of the package.
export default defineConfig({ test: { environment: "node" } });
