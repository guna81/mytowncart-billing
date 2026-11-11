// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { t } from "../i18n";
import { friendlyProblem } from "./syncLabels";

describe("syncLabels", () => {
  it("turns engine problem lines into plain sentences without leaking details", () => {
    expect(friendlyProblem("stock push: HTTP 500 boom")).toBe(t("sync.problem.stock_push"));
    expect(friendlyProblem("catalog read: timeout")).toBe(t("sync.problem.catalog_read"));
    expect(friendlyProblem("catalog: x")).toBe(t("sync.problem.catalog"));
    expect(friendlyProblem("itm_ab12: rejected")).toBe(t("sync.problem.item"));
  });
});
