// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { t } from "./index";

describe("t() plurals", () => {
  it("uses the singular for exactly one", () => {
    expect(t("mtc.publish_done", { count: 1 })).toBe("Published 1 item.");
    expect(t("mtc.publish_done", { count: 3 })).toBe("Published 3 items.");
    expect(t("mtc.publish_done", { count: 0 })).toBe("Published 0 items.");
  });
});
