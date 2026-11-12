// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { t, type I18nKey } from "../i18n";
import { normalizeEditorHtml, toRichHtml } from "../lib/richText";

interface Props {
  /** HTML (or legacy plain text, converted on load). */
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  testId?: string;
}

const COMMANDS: { cmd: string; arg?: string; label: string; key: I18nKey; style?: string }[] = [
  { cmd: "bold", label: "B", key: "rte.bold", style: "font-bold" },
  { cmd: "italic", label: "I", key: "rte.italic", style: "italic" },
  { cmd: "underline", label: "U", key: "rte.underline", style: "underline" },
  { cmd: "insertUnorderedList", label: "•≡", key: "rte.bullets" },
  { cmd: "insertOrderedList", label: "1.", key: "rte.numbers" },
  { cmd: "formatBlock", arg: "h3", label: "H", key: "rte.heading", style: "font-bold" },
  { cmd: "formatBlock", arg: "p", label: "¶", key: "rte.paragraph" },
];

/**
 * Small rich-text box for item descriptions. Content is sanitised against the
 * same allow-list the server uses before it is reported or shown.
 */
export function RichTextEditor({ value, onChange, placeholder, testId }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // The last HTML this editor reported; used to tell our own edits from a value
  // that arrived from outside (an item loading, a pull).
  const lastEmitted = useRef<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (lastEmitted.current !== null && value === lastEmitted.current) return;
    el.innerHTML = toRichHtml(value);
    lastEmitted.current = value;
  }, [value]);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    const html = normalizeEditorHtml(el.innerHTML);
    lastEmitted.current = html;
    onChange(html);
  };

  const run = (cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    emit();
  };

  // window.prompt is not available in the desktop webview, so the URL is typed inline.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("https://");
  const savedRange = useRef<Range | null>(null);

  const openLink = () => {
    const sel = window.getSelection();
    savedRange.current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    setLinkOpen(true);
  };

  const applyLink = () => {
    const url = linkUrl.trim();
    setLinkOpen(false);
    if (!/^(https?:\/\/|mailto:|tel:)/i.test(url)) return;
    const sel = window.getSelection();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    run("createLink", url);
  };

  return (
    <div className="rounded-lg border border-gray-300 bg-white focus-within:ring-2 focus-within:ring-blue-500">
      <div className="flex flex-wrap gap-1 border-b border-gray-200 p-1.5">
        {COMMANDS.map((c) => (
          <button
            key={`${c.cmd}-${c.arg ?? ""}`}
            type="button"
            title={t(c.key)}
            aria-label={t(c.key)}
            // mousedown keeps the selection inside the editor
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(c.cmd, c.arg)}
            className={`min-w-8 rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 ${c.style ?? ""}`}
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          title={t("rte.link")}
          aria-label={t("rte.link")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={openLink}
          className="min-w-8 rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-100"
        >
          🔗
        </button>
      </div>
      {linkOpen && (
        <div className="flex gap-2 border-b border-gray-200 p-1.5">
          <input
            type="url"
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              }
            }}
            aria-label={t("rte.link_prompt")}
            className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
          />
          <button type="button" onClick={applyLink} className="rounded bg-blue-600 px-3 py-1 text-sm text-white">
            {t("rte.link_apply")}
          </button>
          <button type="button" onClick={() => setLinkOpen(false)} className="rounded px-2 py-1 text-sm text-gray-600">
            {t("rte.link_cancel")}
          </button>
        </div>
      )}
      <div
        ref={ref}
        data-testid={testId}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={emit}
        onBlur={emit}
        className="rte-body min-h-28 max-h-80 overflow-y-auto p-3 text-sm text-gray-900 outline-none empty:before:text-gray-400 empty:before:content-[attr(data-placeholder)] [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h3]:text-base [&_h3]:font-bold [&_a]:text-blue-700 [&_a]:underline"
      />
    </div>
  );
}
