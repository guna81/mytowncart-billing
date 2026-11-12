// SPDX-License-Identifier: Apache-2.0
/**
 * Item descriptions are rich text (HTML) on both sides: this app and
 * MyTownCart. The allow-list mirrors the server's (`backend/common/html.py`), so
 * a description pulled from MyTownCart opens in the editor without losing
 * anything, and one written here is never stricter or looser than what the
 * server will keep.
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "div", "span",
  "strong", "b", "em", "i", "u", "s", "strike", "sub", "sup", "small",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "code",
  "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
]);

const ALLOWED_ATTRS: Record<string, readonly string[]> = {
  a: ["href", "title"],
  img: ["src", "alt", "title", "width", "height"],
  th: ["colspan", "rowspan"],
  td: ["colspan", "rowspan"],
};

/** Elements dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template"]);

const SAFE_URL = /^(https?:|mailto:|tel:|\/|#)/i;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** True when the text already holds markup (so it is not legacy plain text). */
export function looksLikeHtml(text: string): boolean {
  return /<\/?(p|br|div|span|strong|b|em|i|u|s|ul|ol|li|h[1-6]|a|table|blockquote)\b[^>]*>/i.test(text);
}

/** Legacy plain text → HTML: blank line = new paragraph, single newline = line break. */
export function plainToHtml(text: string): string {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  if (trimmed === "") return "";
  return trimmed
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** What is sent to MyTownCart: markup as-is (the server sanitises), legacy plain text converted. No DOM needed. */
export function toWireHtml(text: string): string {
  if (text.trim() === "") return "";
  return looksLikeHtml(text) ? text : plainToHtml(text);
}

/** What goes into the editor: markup as-is, legacy plain text converted. */
export function toRichHtml(text: string): string {
  if (text.trim() === "") return "";
  return sanitizeRichHtml(looksLikeHtml(text) ? text : plainToHtml(text));
}

function cleanChildren(source: Node, target: Node, doc: Document): void {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === 3) {
      target.appendChild(doc.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) continue;
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown wrapper: keep its text and allowed descendants.
      cleanChildren(el, target, doc);
      continue;
    }
    const out = doc.createElement(tag);
    for (const attr of ALLOWED_ATTRS[tag] ?? []) {
      const value = el.getAttribute(attr);
      if (value === null) continue;
      if ((attr === "href" || attr === "src") && !SAFE_URL.test(value.trim())) continue;
      out.setAttribute(attr, value);
    }
    if (tag === "a" && out.hasAttribute("href")) out.setAttribute("rel", "noopener noreferrer nofollow");
    cleanChildren(el, out, doc);
    target.appendChild(out);
  }
}

/** Remove everything outside the allow-list (scripts, handlers, styles, unsafe URLs). */
export function sanitizeRichHtml(html: string): string {
  if (html.trim() === "") return "";
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const holder = doc.createElement("div");
  cleanChildren(doc.body, holder, doc);
  return holder.innerHTML;
}

/** Plain text of a description, for emptiness checks and previews. */
export function richTextToPlain(html: string): string {
  if (html.trim() === "") return "";
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  doc.querySelectorAll("p,div,li,h1,h2,h3,h4,h5,h6,blockquote,tr").forEach((el) => el.append("\n"));
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

/** The editor reports "" for an empty box instead of `<p><br></p>`. */
export function normalizeEditorHtml(html: string): string {
  const clean = sanitizeRichHtml(html);
  return richTextToPlain(clean) === "" && !/<(img|hr|table)\b/i.test(clean) ? "" : clean;
}

/** Short, stable fingerprint of a description string (FNV-1a), for sync baselines. */
export function descriptionFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${h.toString(36)}`;
}
