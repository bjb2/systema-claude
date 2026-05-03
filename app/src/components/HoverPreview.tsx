// Hover preview tooltip (T6.1).
//
// Listens at document level for mouseover on link-like elements:
//   - `a.cm-md-link`        — markdown link widgets in the editor
//   - `.cm-wikilink`        — wikilink mark spans in the editor
//   - `[data-doc-path]`     — relation panel rows
//
// After a 400 ms hover, resolves the target to a doc and shows a fixed-position
// popover with title, status, and the first ~3 non-empty lines of body.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { OrgDocument } from "../types";
import type { Theme } from "../themes";

const HOVER_DELAY_MS = 400;
const SELECTOR = "a.cm-md-link, .cm-wikilink, [data-doc-path]";

interface Props {
  docs: OrgDocument[];
  theme: Theme;
}

interface Active {
  el: HTMLElement;
  doc: OrgDocument;
}

function resolveDoc(el: HTMLElement, docs: OrgDocument[]): OrgDocument | null {
  // Relations panel — explicit path
  const path = el.dataset.docPath;
  if (path) return docs.find((d) => d.path === path) ?? null;

  // Wikilink — slug from data-wikilink
  const slug = el.dataset.wikilink;
  if (slug) return matchSlug(slug, docs);

  // Markdown link widget — url is the href / data-url
  const a = el as HTMLAnchorElement;
  const url = a.dataset.url || a.getAttribute?.("href") || "";
  if (!url || /^https?:\/\//i.test(url)) return null;
  const norm = url.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "");
  return matchSlug(norm, docs);
}

function matchSlug(slug: string, docs: OrgDocument[]): OrgDocument | null {
  const target = `/${slug}.md`;
  return (
    docs.find((d) => {
      const base = d.filename.replace(/\.md$/, "");
      const path = d.path.replace(/\\/g, "/");
      return base === slug || path.endsWith(target);
    }) ?? null
  );
}

function previewBody(content: string): string {
  let s = content;
  if (s.startsWith("---")) {
    const end = s.indexOf("\n---", 3);
    if (end > 0) s = s.slice(end + 4);
  }
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .slice(0, 3);
  let out = lines.join("\n");
  if (out.length > 240) out = out.slice(0, 240) + "…";
  return out;
}

export default function HoverPreview({ docs, theme }: Props) {
  const [active, setActive] = useState<Active | null>(null);
  const timerRef = useRef<number | null>(null);
  const docsRef = useRef(docs);
  docsRef.current = docs;

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest) return;
      const el = t.closest(SELECTOR) as HTMLElement | null;
      if (!el) return;
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        const doc = resolveDoc(el, docsRef.current);
        if (doc) setActive({ el, doc });
        else setActive(null);
      }, HOVER_DELAY_MS);
    };

    const onOut = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest) return;
      const el = t.closest(SELECTOR) as HTMLElement | null;
      if (!el) return;
      const related = e.relatedTarget as HTMLElement | null;
      if (related && el.contains(related)) return;
      clearTimer();
      setActive(null);
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      clearTimer();
    };
  }, []);

  if (!active) return null;

  const rect = active.el.getBoundingClientRect();
  const width = 340;
  const margin = 8;
  let left = rect.left;
  if (left + width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - width - margin);
  }
  let top = rect.bottom + 6;
  // Flip above if the popover would clip the viewport bottom
  const estHeight = 120;
  if (top + estHeight > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - estHeight - 6);
  }

  const { doc } = active;
  const preview = previewBody(doc.content);

  return createPortal(
    <div
      style={{
        position: "fixed",
        left,
        top,
        width,
        zIndex: 9999,
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        padding: "8px 10px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        pointerEvents: "none",
        fontSize: 12,
        lineHeight: 1.45,
        color: theme.text,
        fontFamily:
          "Cascadia Code, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: preview ? 6 : 0,
        }}
      >
        <Dot status={doc.status} theme={theme} />
        <span
          style={{
            fontWeight: 600,
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {doc.title || doc.filename.replace(/\.md$/, "")}
        </span>
        {doc.status && (
          <span
            style={{
              fontSize: 10,
              color: theme.textDim,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {doc.status}
          </span>
        )}
      </div>
      {preview && (
        <div
          style={{
            color: theme.textDim,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {preview}
        </div>
      )}
    </div>,
    document.body,
  );
}

function Dot({ status, theme }: { status?: string; theme: Theme }) {
  const color =
    status === "complete"
      ? theme.success
      : status === "blocked"
        ? theme.warning
        : status === "paused"
          ? theme.textDim
          : theme.accent;
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}
