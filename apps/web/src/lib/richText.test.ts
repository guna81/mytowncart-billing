// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  descriptionFingerprint,
  looksLikeHtml,
  normalizeEditorHtml,
  plainToHtml,
  richTextToPlain,
  sanitizeRichHtml,
  toRichHtml,
  toWireHtml,
} from "./richText";

describe("richText", () => {
  it("turns legacy plain text into paragraphs and line breaks, escaping markup", () => {
    expect(plainToHtml("Line one\nline two\n\nSecond <b>para</b>")).toBe(
      "<p>Line one<br>line two</p><p>Second &lt;b&gt;para&lt;/b&gt;</p>",
    );
    expect(plainToHtml("   ")).toBe("");
  });

  it("tells markup from plain text", () => {
    expect(looksLikeHtml("<p>Hi</p>")).toBe(true);
    expect(looksLikeHtml("5 < 6 and 7 > 3")).toBe(false);
    expect(toWireHtml("Plain")).toBe("<p>Plain</p>");
    expect(toWireHtml("<p>Already</p>")).toBe("<p>Already</p>");
  });

  it("strips scripts, handlers, styles and unsafe links but keeps formatting", () => {
    const dirty =
      '<p onclick="x()" style="color:red">Hi <strong>there</strong><script>alert(1)</script></p>' +
      '<a href="javascript:alert(1)">bad</a><a href="https://shop.example/a">good</a><img src="data:text/html;base64,AA" alt="x">';
    const clean = sanitizeRichHtml(dirty);
    expect(clean).toContain("<strong>there</strong>");
    expect(clean).not.toMatch(/script|onclick|style=|javascript:|data:/i);
    expect(clean).toContain('href="https://shop.example/a"');
  });

  it("keeps the tags the server keeps (lists, headings, tables)", () => {
    const html = "<h3>Care</h3><ul><li>Wash</li></ul><table><tbody><tr><td>1</td></tr></tbody></table>";
    expect(sanitizeRichHtml(html)).toBe(html);
  });

  it("converts legacy text for the editor and reads plain text back", () => {
    expect(toRichHtml("A\nB")).toBe("<p>A<br>B</p>");
    expect(richTextToPlain("<p>A<br>B</p><ul><li>C</li></ul>")).toBe("A\nB\nC");
  });

  it("reports an emptied editor as an empty string", () => {
    expect(normalizeEditorHtml("<p><br></p>")).toBe("");
    expect(normalizeEditorHtml("<p>Text</p>")).toBe("<p>Text</p>");
  });

  it("fingerprints equal text equally", () => {
    expect(descriptionFingerprint("<p>a</p>")).toBe(descriptionFingerprint("<p>a</p>"));
    expect(descriptionFingerprint("<p>a</p>")).not.toBe(descriptionFingerprint("<p>b</p>"));
  });
});
