// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { APP_NAME, APP_SLUG, APP_VERSION } from "../src/index.js";

describe("app identity", () => {
  it("uses the decided name and slug (roadmap D10)", () => {
    expect(APP_NAME).toBe("MyTownCart Billing");
    expect(APP_SLUG).toBe("mytowncart-billing");
  });

  it("has a semver version", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
