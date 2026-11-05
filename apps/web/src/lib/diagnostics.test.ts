// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";

import {
  diagnosticsEnabled,
  diagnosticsReport,
  recordedEvents,
  recordEvent,
  redact,
  setDiagnosticsEnabled,
} from "./diagnostics";

afterEach(() => setDiagnosticsEnabled(false));

describe("pilot diagnostics", () => {
  it("records nothing until the seller opts in", () => {
    recordEvent("screen", "/items");
    expect(diagnosticsEnabled()).toBe(false);
    expect(recordedEvents()).toEqual([]);
  });

  it("records screens once enabled and forgets them when switched off", () => {
    setDiagnosticsEnabled(true);
    recordEvent("screen", "/items");
    recordEvent("error", "save", "network down");
    expect(recordedEvents().map((e) => e.name)).toEqual(["diagnostics on", "/items", "save"]);
    setDiagnosticsEnabled(false);
    setDiagnosticsEnabled(true);
    expect(recordedEvents().map((e) => e.name)).toEqual(["diagnostics on"]);
  });

  it("records nothing while off", () => {
    setDiagnosticsEnabled(false);
    recordEvent("screen", "/items");
    expect(recordedEvents()).toEqual([]);
  });

  it("redacts recovery keys and tokens", () => {
    const key = "ABCA FGHK JKLM NOPQ RSTU VWXY Z234 5672";
    const out = redact(`key ${key} done`);
    expect(out).toContain("[recovery key]");
    expect(out).not.toContain("Z234");
    expect(redact("Authorization Bearer abcdefghijklmnopqrstuvwxyz0123456789")).not.toContain("abcdefghij");
  });

  it("builds a report with the environment and the events", () => {
    setDiagnosticsEnabled(true);
    recordEvent("screen", "/reports");
    const report = diagnosticsReport(false, new Date("2026-11-05T10:00:00.000Z"));
    expect(report).toContain("generated: 2026-11-05T10:00:00.000Z");
    expect(report).toContain("desktop shell: no");
    expect(report).toContain("/reports");
  });
});
