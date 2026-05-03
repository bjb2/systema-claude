// Inline live-preview decorations for the markdown editor.
//
// Hides syntax markers and styles inline runs so the source editor reads
// like rendered markdown — without changing the underlying document. The
// active line keeps its raw markers so the user can edit them.
//
// All decorations here are INLINE (no { block: true }) so a ViewPlugin is
// safe; CM6 only forbids block decorations from plugins.

import { Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

interface LivePreviewOpts {
  onOpenUrl?: (url: string) => void;
}

// ---------- widgets ----------

class LinkWidget extends WidgetType {
  constructor(readonly label: string, readonly url: string) {
    super();
  }
  override eq(other: LinkWidget): boolean {
    return other.label === this.label && other.url === this.url;
  }
  override toDOM(): HTMLElement {
    const a = document.createElement("a");
    a.className = "cm-md-link";
    a.textContent = this.label;
    a.dataset.url = this.url;
    a.href = this.url;
    a.title = this.url;
    return a;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-checkbox" + (this.checked ? " cm-md-checkbox-on" : "");
    span.textContent = this.checked ? "■" : "□"; // ■ / □
    span.dataset.pos = String(this.pos);
    span.dataset.checked = this.checked ? "1" : "0";
    return span;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

// ---------- regexes ----------

// Order matters: longer markers first.
const HEADING_RE = /^(#{1,6}) +/;
const BLOCKQUOTE_RE = /^> +/;
const TASK_RE = /^(\s*[-*+]\s)\[( |x|X)\]/;
const BOLD_RE = /(\*\*|__)(?=\S)([\s\S]+?\S)\1/g;
const ITALIC_RE = /(?<![*_\w])([*_])(?=\S)([^*_\n]+?\S)\1(?![*_\w])/g;
const CODE_RE = /(`+)([^`\n]+?)\1/g;
// Negative lookbehind on `!` so image syntax `![alt](path)` is left alone for
// the imageWidget block decoration; otherwise this inline replace would
// overlap with the block replace and the line would render as a bare link.
const MD_LINK_RE = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)\)/g;
// bare URL not preceded by ( (so we skip the URL inside markdown links)
const BARE_URL_RE = /(^|[^([])(https?:\/\/[^\s)<>]+)/g;

// ---------- builder ----------

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const sel = state.selection.main;
  const cursorLine = state.doc.lineAt(sel.head).number;

  type Range = {
    from: number;
    to: number;
    deco: Decoration;
    rank: number; // lower = earlier; used to break ties so RangeSetBuilder sees sorted input
  };
  const ranges: Range[] = [];

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (line.from > to) break;
      const text = line.text;
      const lineFrom = line.from;
      const isActive = line.number === cursorLine;

      // ATX heading
      const hMatch = HEADING_RE.exec(text);
      let contentStart = 0;
      let headingLevel = 0;
      if (hMatch) {
        headingLevel = hMatch[1].length;
        contentStart = hMatch[0].length;
        // mark the heading text class across the whole line content
        if (line.to > lineFrom + contentStart) {
          ranges.push({
            from: lineFrom + contentStart,
            to: line.to,
            deco: Decoration.mark({ class: `cm-h${headingLevel}` }),
            rank: 0,
          });
        }
        if (!isActive) {
          ranges.push({
            from: lineFrom,
            to: lineFrom + contentStart,
            deco: Decoration.replace({}),
            rank: 0,
          });
        }
      }

      // Blockquote
      const qMatch = !hMatch ? BLOCKQUOTE_RE.exec(text) : null;
      if (qMatch) {
        if (line.to > lineFrom + qMatch[0].length) {
          ranges.push({
            from: lineFrom + qMatch[0].length,
            to: line.to,
            deco: Decoration.mark({ class: "cm-md-quote" }),
            rank: 0,
          });
        }
        if (!isActive) {
          ranges.push({
            from: lineFrom,
            to: lineFrom + qMatch[0].length,
            deco: Decoration.replace({}),
            rank: 0,
          });
        }
      }

      // Task checkbox: replace the `[ ]` or `[x]` portion with a clickable widget
      const tMatch = TASK_RE.exec(text);
      if (tMatch) {
        const bracketStart = lineFrom + tMatch[1].length;
        const bracketEnd = bracketStart + 3; // `[ ]` or `[x]`
        const checked = tMatch[2].toLowerCase() === "x";
        ranges.push({
          from: bracketStart,
          to: bracketEnd,
          deco: Decoration.replace({
            widget: new CheckboxWidget(checked, bracketStart),
          }),
          rank: 0,
        });
      }

      // Inline-run scans on the body (after heading/quote prefix)
      const bodyStart = contentStart || (qMatch ? qMatch[0].length : 0);
      const body = text.slice(bodyStart);
      const bodyAbs = lineFrom + bodyStart;

      // Inline code first (so we don't decorate inside it)
      const codeRanges: Array<[number, number]> = [];
      CODE_RE.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = CODE_RE.exec(body)) !== null) {
        const start = bodyAbs + cm.index;
        const end = start + cm[0].length;
        const tickLen = cm[1].length;
        codeRanges.push([start, end]);
        ranges.push({
          from: start + tickLen,
          to: end - tickLen,
          deco: Decoration.mark({ class: "cm-md-code" }),
          rank: 1,
        });
        if (!isActive) {
          ranges.push({
            from: start,
            to: start + tickLen,
            deco: Decoration.replace({}),
            rank: 1,
          });
          ranges.push({
            from: end - tickLen,
            to: end,
            deco: Decoration.replace({}),
            rank: 1,
          });
        }
      }
      const inCode = (p: number) =>
        codeRanges.some(([a, b]) => p >= a && p < b);

      // Markdown links [label](url)
      const linkRanges: Array<[number, number]> = [];
      MD_LINK_RE.lastIndex = 0;
      let lm: RegExpExecArray | null;
      while ((lm = MD_LINK_RE.exec(body)) !== null) {
        const start = bodyAbs + lm.index;
        const end = start + lm[0].length;
        if (inCode(start)) continue;
        linkRanges.push([start, end]);
        if (isActive) {
          // keep raw, but mark url portion
          ranges.push({
            from: start,
            to: end,
            deco: Decoration.mark({ class: "cm-md-link-raw" }),
            rank: 2,
          });
        } else {
          ranges.push({
            from: start,
            to: end,
            deco: Decoration.replace({
              widget: new LinkWidget(lm[1], lm[2]),
            }),
            rank: 2,
          });
        }
      }
      const inLink = (p: number) =>
        linkRanges.some(([a, b]) => p >= a && p < b);

      // Bare URLs
      BARE_URL_RE.lastIndex = 0;
      let um: RegExpExecArray | null;
      while ((um = BARE_URL_RE.exec(body)) !== null) {
        const urlStart = bodyAbs + um.index + um[1].length;
        const url = um[2];
        const urlEnd = urlStart + url.length;
        if (inCode(urlStart) || inLink(urlStart)) continue;
        ranges.push({
          from: urlStart,
          to: urlEnd,
          deco: Decoration.mark({
            class: "cm-md-link",
            attributes: { "data-url": url },
          }),
          rank: 2,
        });
      }

      // Bold
      BOLD_RE.lastIndex = 0;
      let bm: RegExpExecArray | null;
      while ((bm = BOLD_RE.exec(body)) !== null) {
        const start = bodyAbs + bm.index;
        const end = start + bm[0].length;
        if (inCode(start) || inLink(start)) continue;
        const markLen = bm[1].length;
        ranges.push({
          from: start + markLen,
          to: end - markLen,
          deco: Decoration.mark({ class: "cm-strong" }),
          rank: 3,
        });
        if (!isActive) {
          ranges.push({
            from: start,
            to: start + markLen,
            deco: Decoration.replace({}),
            rank: 3,
          });
          ranges.push({
            from: end - markLen,
            to: end,
            deco: Decoration.replace({}),
            rank: 3,
          });
        }
      }

      // Italic — single * or _
      ITALIC_RE.lastIndex = 0;
      let im: RegExpExecArray | null;
      while ((im = ITALIC_RE.exec(body)) !== null) {
        const start = bodyAbs + im.index;
        const end = start + im[0].length;
        if (inCode(start) || inLink(start)) continue;
        ranges.push({
          from: start + 1,
          to: end - 1,
          deco: Decoration.mark({ class: "cm-em" }),
          rank: 4,
        });
        if (!isActive) {
          ranges.push({
            from: start,
            to: start + 1,
            deco: Decoration.replace({}),
            rank: 4,
          });
          ranges.push({
            from: end - 1,
            to: end,
            deco: Decoration.replace({}),
            rank: 4,
          });
        }
      }

      pos = line.to + 1;
    }
  }

  // RangeSetBuilder requires sorted input. Sort by from, then by a "side"
  // heuristic: replace decorations should come before mark decorations at
  // identical positions to satisfy CM6's ordering rules.
  ranges.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    if (a.to !== b.to) return a.to - b.to;
    return a.rank - b.rank;
  });
  for (const r of ranges) builder.add(r.from, r.to, r.deco);
  return builder.finish();
}

// ---------- plugin ----------

export function livePreviewExtension(opts?: LivePreviewOpts): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = buildDecorations(u.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e: MouseEvent, view: EditorView) {
          const target = e.target as HTMLElement | null;
          if (!target) return false;

          // Checkbox toggle
          const cb = target.closest(".cm-md-checkbox") as HTMLElement | null;
          if (cb) {
            const posStr = cb.dataset.pos;
            const checked = cb.dataset.checked === "1";
            if (posStr) {
              const pos = Number(posStr);
              const replacement = checked ? "[ ]" : "[x]";
              e.preventDefault();
              view.dispatch({
                changes: { from: pos, to: pos + 3, insert: replacement },
              });
              return true;
            }
          }

          // Plain click on a rendered link widget (`a.cm-md-link` from
          // the LinkWidget replace decoration) navigates. The widget is
          // already a non-editable replacement, so a plain click should
          // open the target rather than place a cursor.
          const linkAnchor = target.closest("a.cm-md-link") as
            | HTMLAnchorElement
            | null;
          if (linkAnchor) {
            const url = linkAnchor.dataset.url || linkAnchor.getAttribute("href") || "";
            if (url) {
              e.preventDefault();
              if (opts?.onOpenUrl) opts.onOpenUrl(url);
              else window.open(url, "_blank");
              return true;
            }
          }

          // Bare URLs are styled as marks on raw text, so plain click must
          // still position the cursor; require ctrl/cmd to open.
          if (e.ctrlKey || e.metaKey) {
            const link = target.closest(".cm-md-link") as HTMLElement | null;
            if (link) {
              const url = link.dataset.url;
              if (url) {
                e.preventDefault();
                if (opts?.onOpenUrl) opts.onOpenUrl(url);
                else window.open(url, "_blank");
                return true;
              }
            }
          }
          return false;
        },
      },
    },
  );

  const theme = EditorView.baseTheme({
    ".cm-h1": { fontSize: "22px", fontWeight: "700", lineHeight: "1.3" },
    ".cm-h2": { fontSize: "18px", fontWeight: "650", lineHeight: "1.3" },
    ".cm-h3": { fontSize: "16px", fontWeight: "600", lineHeight: "1.3" },
    ".cm-h4": { fontSize: "14px", fontWeight: "600" },
    ".cm-h5": { fontSize: "14px", fontWeight: "600" },
    ".cm-h6": { fontSize: "14px", fontWeight: "600" },
    ".cm-strong": { fontWeight: "700" },
    ".cm-em": { fontStyle: "italic" },
    ".cm-md-code": {
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      background: "var(--bg-tertiary, rgba(255,255,255,0.06))",
      padding: "1px 4px",
      borderRadius: "3px",
    },
    ".cm-md-link": {
      color: "var(--accent, #4a9eff)",
      textDecoration: "underline dotted",
      cursor: "pointer",
    },
    "a.cm-md-link": {
      color: "var(--accent, #4a9eff)",
      textDecoration: "underline dotted",
      cursor: "pointer",
    },
    ".cm-md-link-raw": {
      color: "var(--accent, #4a9eff)",
    },
    ".cm-md-quote": {
      borderLeft: "3px solid var(--border, #2a2a3a)",
      paddingLeft: "12px",
      color: "var(--text-muted, #aaa)",
      display: "inline-block",
    },
    ".cm-md-checkbox": {
      display: "inline-block",
      width: "14px",
      fontSize: "14px",
      cursor: "pointer",
      color: "var(--text-muted, #aaa)",
      userSelect: "none",
    },
    ".cm-md-checkbox-on": {
      color: "var(--accent, #4a9eff)",
    },
  });

  return [plugin, theme];
}
