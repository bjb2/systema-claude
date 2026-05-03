// Inline image widget decoration for CodeMirror 6 (T2.3).
//
// Replaces lines that are exactly `![alt](path)` with a rendered <img>.
// Clicking the image (or moving the cursor onto its line) collapses the
// widget back to source so the markdown can be edited. Relative paths are
// resolved against `docDir` and loaded via Tauri `convertFileSrc` so the
// WebView can fetch them through the asset protocol.

import { Extension, RangeSetBuilder, StateField, StateEffect, EditorState, Transaction } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";

// Match a line whose entire trimmed contents are `![alt](path)`. Captures
// alt text and the raw path.
const IMAGE_LINE_RE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly onActivate: () => void,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-inline-image";
    wrap.style.cssText =
      "display:flex;justify-content:flex-start;padding:6px 0;cursor:pointer;";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.style.cssText =
      "max-width:100%;max-height:480px;border-radius:4px;border:1px solid var(--border,#2a2a3a);";
    img.title = this.alt || "click to edit source";
    wrap.appendChild(img);
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.onActivate();
    });
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function resolvePath(rel: string, docDir: string | null): string {
  if (/^(https?:|data:|blob:|asset:|file:)/i.test(rel)) return rel;
  if (!docDir) return rel;
  // Normalize separators; rel is markdown-style (forward-slash).
  const sep = docDir.includes("\\") ? "\\" : "/";
  // Drop leading "./"
  const cleaned = rel.replace(/^\.\//, "").replace(/\//g, sep);
  const abs = `${docDir}${sep}${cleaned}`;
  try {
    return convertFileSrc(abs);
  } catch {
    return rel;
  }
}

// Effect to manually request a "show source" for a specific line (when the
// user clicks the rendered image). The state field tracks lines that should
// remain expanded even when the cursor is elsewhere — none for now; we just
// rely on cursor-on-line to skip the decoration.
const setEditingLine = StateEffect.define<number | null>();

const editingLineField = StateField.define<number | null>({
  create() {
    return null;
  },
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setEditingLine)) next = e.value;
    }
    // Clear when the cursor leaves the editing line.
    if (next != null && tr.docChanged) {
      // doc changed — line numbers may shift; clear and rely on cursor.
      next = null;
    }
    return next;
  },
});

function buildDecorations(state: EditorState, docDir: string | null, view: () => EditorView | null): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = state.selection.main;
  const cursorLine = state.doc.lineAt(sel.head).number;
  const editingLine = state.field(editingLineField, false);

  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const m = IMAGE_LINE_RE.exec(line.text);
    if (!m) continue;
    if (line.number === cursorLine || line.number === editingLine) continue;
    const alt = m[1];
    const path = m[2];
    const src = resolvePath(path, docDir);
    const lineNum = line.number;
    const widget = new ImageWidget(src, alt, () => {
      const v = view();
      if (!v) return;
      v.dispatch({
        effects: setEditingLine.of(lineNum),
        selection: { anchor: line.from },
      });
      v.focus();
    });
    builder.add(line.from, line.to, Decoration.replace({ widget, block: true }));
  }
  return builder.finish();
}

export function imageWidgetPlugin(getDocDir: () => string | null): Extension {
  // Block decorations must come from a StateField (per CM6 rules); a ViewPlugin
  // throws "Block decorations may not be specified via plugins".
  let viewRef: EditorView | null = null;
  const captureView = EditorView.updateListener.of((u) => {
    viewRef = u.view;
  });

  const decoField = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, getDocDir(), () => viewRef);
    },
    update(deco, tr: Transaction) {
      const editing = tr.effects.some((e) => e.is(setEditingLine));
      if (!tr.docChanged && tr.selection == null && !editing) return deco;
      return buildDecorations(tr.state, getDocDir(), () => viewRef);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return [editingLineField, decoField, captureView];
}
