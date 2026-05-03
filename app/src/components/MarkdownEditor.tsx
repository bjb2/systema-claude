import { useEffect, useRef, useState } from "react";
import { EditorState, Extension, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { invoke } from "@tauri-apps/api/core";
import { wikilinkPlugin } from "../editor/wikilinkDecoration";
import { imageWidgetPlugin } from "../editor/imageWidget";
import { livePreviewExtension } from "../editor/livePreview";

export type SaveState = "saved" | "saving" | "unsaved";

export interface MarkdownEditorProps {
  value: string;
  /** Absolute path of the doc on disk. Used as `near_path` for asset writes
   *  and as the base for resolving relative image src. */
  docPath: string;
  onChange?: (value: string) => void;
  theme?: Extension;
  onSave?: (value: string) => void | Promise<void>;
  onStateChange?: (state: SaveState) => void;
  onWikilinkNavigate?: (slug: string) => void;
  saveDebounceMs?: number;
}

// Image MIME type -> file extension (used for paste/drop assets).
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    );
  }
  return btoa(s);
}

async function fileToBase64(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return bytesToBase64(buf);
}

function dirOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i < 0) return path;
  // Preserve original separator style on the prefix when possible.
  const sliced = norm.slice(0, i);
  return path.includes("\\") ? sliced.replace(/\//g, "\\") : sliced;
}

// GFM table format command (T2.7). Pads cell widths so columns align.
// Triggered by Ctrl+Shift+T.
function formatTableAtCursor(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const startLine = state.doc.lineAt(sel.head);

  const isTableLine = (s: string) => /^\s*\|.*\|\s*$/.test(s);
  if (!isTableLine(startLine.text)) return false;

  let firstNum = startLine.number;
  while (firstNum > 1 && isTableLine(state.doc.line(firstNum - 1).text)) {
    firstNum--;
  }
  let lastNum = startLine.number;
  while (
    lastNum < state.doc.lines &&
    isTableLine(state.doc.line(lastNum + 1).text)
  ) {
    lastNum++;
  }
  if (lastNum - firstNum < 1) return false;

  const lines: string[] = [];
  for (let n = firstNum; n <= lastNum; n++) {
    lines.push(state.doc.line(n).text);
  }

  const rows = lines.map((line) => {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((c) => c.trim());
  });
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = new Array(cols).fill(0);

  // Detect alignment row (`:---`, `---:`, `:---:`, `---`) and skip it for width.
  const isSepRow = (cells: string[]) =>
    cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));

  rows.forEach((r) => {
    if (isSepRow(r)) return;
    r.forEach((c, i) => {
      widths[i] = Math.max(widths[i], c.length);
    });
  });
  // Minimum 3 to accommodate `---`.
  for (let i = 0; i < cols; i++) widths[i] = Math.max(widths[i], 3);

  const align: ("l" | "c" | "r")[] = new Array(cols).fill("l");
  const sep = rows.find(isSepRow);
  if (sep) {
    sep.forEach((c, i) => {
      const t = c.trim();
      const left = t.startsWith(":");
      const right = t.endsWith(":");
      align[i] = left && right ? "c" : right ? "r" : left ? "l" : "l";
    });
  }

  const renderCell = (text: string, i: number): string => {
    const w = widths[i];
    if (align[i] === "r") return text.padStart(w, " ");
    if (align[i] === "c") {
      const pad = w - text.length;
      const left = Math.floor(pad / 2);
      const right = pad - left;
      return " ".repeat(left) + text + " ".repeat(right);
    }
    return text.padEnd(w, " ");
  };

  const renderSep = (i: number): string => {
    const w = widths[i];
    const dashes = "-".repeat(w);
    if (align[i] === "c") return ":" + "-".repeat(w - 2) + ":";
    if (align[i] === "r") return "-".repeat(w - 1) + ":";
    if (align[i] === "l") return dashes;
    return dashes;
  };

  const out = rows
    .map((r) => {
      if (isSepRow(r)) {
        return (
          "| " +
          new Array(cols)
            .fill(0)
            .map((_, i) => renderSep(i))
            .join(" | ") +
          " |"
        );
      }
      // Pad row to `cols` columns.
      const padded = new Array(cols).fill("").map((_, i) => r[i] ?? "");
      return "| " + padded.map((c, i) => renderCell(c, i)).join(" | ") + " |";
    })
    .join("\n");

  view.dispatch({
    changes: {
      from: state.doc.line(firstNum).from,
      to: state.doc.line(lastNum).to,
      insert: out,
    },
  });
  return true;
}

export function MarkdownEditor({
  value,
  docPath,
  onChange,
  theme,
  onSave,
  onStateChange,
  onWikilinkNavigate,
  saveDebounceMs = 1500,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment()).current;

  const valueRef = useRef(value);
  const lastSavedRef = useRef(value);
  const debounceTimerRef = useRef<number | null>(null);
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onChange);
  const onStateChangeRef = useRef(onStateChange);
  const onWikilinkRef = useRef(onWikilinkNavigate);
  const docPathRef = useRef(docPath);

  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);
  useEffect(() => {
    onWikilinkRef.current = onWikilinkNavigate;
  }, [onWikilinkNavigate]);
  useEffect(() => {
    docPathRef.current = docPath;
  }, [docPath]);

  const setStateAndNotify = (s: SaveState) => {
    setSaveState(s);
    onStateChangeRef.current?.(s);
  };

  const cancelDebounce = () => {
    if (debounceTimerRef.current != null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  };

  const doSave = async () => {
    if (!onSaveRef.current) {
      lastSavedRef.current = valueRef.current;
      setStateAndNotify("saved");
      return;
    }
    const snapshot = valueRef.current;
    setStateAndNotify("saving");
    try {
      await onSaveRef.current(snapshot);
      if (snapshot === valueRef.current) {
        lastSavedRef.current = snapshot;
        setStateAndNotify("saved");
      } else {
        setStateAndNotify("unsaved");
      }
    } catch {
      setStateAndNotify("unsaved");
    }
  };

  const saveNow = () => {
    cancelDebounce();
    if (valueRef.current === lastSavedRef.current) {
      setStateAndNotify("saved");
      return;
    }
    void doSave();
  };

  // Insert a markdown image reference at the current cursor.
  const insertImageRef = (relPath: string, view: EditorView) => {
    const sel = view.state.selection.main;
    const before = view.state.doc.sliceString(
      Math.max(0, sel.from - 1),
      sel.from,
    );
    const after = view.state.doc.sliceString(
      sel.to,
      Math.min(view.state.doc.length, sel.to + 1),
    );
    // Force the image onto its own line so the widget can render.
    const prefix = before === "" || before === "\n" ? "" : "\n";
    const suffix = after === "" || after === "\n" ? "" : "\n";
    const insert = `${prefix}![](${relPath})${suffix}`;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + insert.length },
    });
  };

  const persistAsset = async (
    blob: Blob,
    mime: string,
    fallbackName?: string,
  ): Promise<string | null> => {
    let ext = MIME_EXT[mime];
    if (!ext && fallbackName) {
      const dot = fallbackName.lastIndexOf(".");
      if (dot >= 0) ext = fallbackName.slice(dot + 1).toLowerCase();
    }
    if (!ext) return null;
    try {
      const b64 = await fileToBase64(blob);
      const rel = await invoke<string>("save_pasted_asset", {
        nearPath: docPathRef.current,
        ext,
        bytesB64: b64,
      });
      return rel;
    } catch (err) {
      console.error("save_pasted_asset failed", err);
      return null;
    }
  };

  // Mount once
  useEffect(() => {
    if (!hostRef.current) return;

    const updateListener = EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      const next = u.state.doc.toString();
      valueRef.current = next;
      onChangeRef.current?.(next);
      if (next === lastSavedRef.current) {
        setStateAndNotify("saved");
        cancelDebounce();
        return;
      }
      setStateAndNotify("unsaved");
      cancelDebounce();
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        void doSave();
      }, saveDebounceMs);
    });

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          saveNow();
          return true;
        },
      },
      {
        key: "Mod-Shift-t",
        preventDefault: true,
        run: (view) => formatTableAtCursor(view),
      },
      {
        // Manual image paste — always reads the OS clipboard via Tauri.
        // Useful when Ctrl+V doesn't surface a Win+Shift+S bitmap through
        // the WebView's DOM clipboard APIs.
        key: "Mod-Shift-v",
        preventDefault: true,
        run: (view) => {
          void tryTauriClipboard(view);
          return true;
        },
      },
    ]);

    // Paste handler (T2.4): grab any image in clipboardData and persist it.
    // Three layered paths so Win+Shift+S (Snipping Tool) works reliably:
    //   1. clipboardData.items kind=file image/*  (most browsers, drag-paste)
    //   2. clipboardData "text/html" with <img src="data:image/...">
    //   3. async navigator.clipboard.read() ClipboardItem with image/* blob
    const tryHtmlDataUrl = async (
      html: string,
      view: EditorView,
    ): Promise<boolean> => {
      const m = /<img[^>]+src="(data:image\/([a-zA-Z0-9+]+);base64,([^"]+))"/i.exec(
        html,
      );
      if (!m) return false;
      const mime = `image/${m[2].toLowerCase()}`;
      try {
        const res = await fetch(m[1]);
        const blob = await res.blob();
        const rel = await persistAsset(blob, mime);
        if (rel) {
          insertImageRef(rel, view);
          console.info("[paste] inserted image via text/html data URL");
          return true;
        }
      } catch (err) {
        console.warn("[paste] html data-url path failed", err);
      }
      return false;
    };

    const tryAsyncClipboard = async (view: EditorView): Promise<boolean> => {
      try {
        if (!navigator.clipboard?.read) return false;
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imgType = item.types.find((t) => t.startsWith("image/"));
          if (!imgType) continue;
          const blob = await item.getType(imgType);
          const rel = await persistAsset(blob, imgType);
          if (rel) {
            insertImageRef(rel, view);
            console.info("[paste] inserted image via navigator.clipboard.read");
            return true;
          }
        }
      } catch (err) {
        // Permission/focus errors are expected in some contexts.
        console.warn("[paste] async clipboard path failed", err);
      }
      return false;
    };

    // Path 4: native OS clipboard via Tauri (arboard). Reliable for Win+Shift+S
    // bitmaps that WebView2 doesn't surface through the DOM clipboard APIs.
    const tryTauriClipboard = async (view: EditorView): Promise<boolean> => {
      try {
        const rel = await invoke<string>("save_clipboard_image", {
          nearPath: docPathRef.current,
        });
        if (rel) {
          insertImageRef(rel, view);
          console.info("[paste] inserted image via tauri arboard");
          return true;
        }
      } catch (err) {
        console.warn("[paste] tauri clipboard path failed", err);
      }
      return false;
    };

    const pasteHandler = EditorView.domEventHandlers({
      paste: (e, view) => {
        const cd = e.clipboardData;
        const items = cd?.items;
        // Path 1: synchronous file item.
        if (items) {
          for (const item of items) {
            if (item.kind === "file" && item.type.startsWith("image/")) {
              const file = item.getAsFile();
              if (!file) continue;
              e.preventDefault();
              void (async () => {
                const rel = await persistAsset(file, file.type, file.name);
                if (rel) {
                  insertImageRef(rel, view);
                  console.info("[paste] inserted image via clipboard file");
                }
              })();
              return true;
            }
          }
        }

        // Path 2: HTML payload with embedded data URL (Snipping Tool, etc.).
        const html = cd?.getData("text/html");
        if (html && /<img[^>]+src="data:image\//i.test(html)) {
          e.preventDefault();
          void (async () => {
            const ok = await tryHtmlDataUrl(html, view);
            if (!ok) {
              const ok2 = await tryAsyncClipboard(view);
              if (!ok2) await tryTauriClipboard(view);
            }
          })();
          return true;
        }

        // Path 3: types hint at an image but no synchronous file — async fallback.
        const types = cd?.types ?? [];
        const hasImageType = Array.from(types).some((t) =>
          t.startsWith("image/"),
        );
        if (hasImageType) {
          e.preventDefault();
          void (async () => {
            const ok = await tryAsyncClipboard(view);
            if (!ok) await tryTauriClipboard(view);
          })();
          return true;
        }

        // Path 4: nothing in clipboardData hinted at an image, but the user
        // pressed Ctrl+V. Win+Shift+S bitmaps land here on WebView2 — neither
        // `items` nor `types` exposes them. Only intercept when the clipboard
        // appears to contain no text at all (so plain-text pastes still go
        // through CM6's default handler).
        const hasText =
          Array.from(types).some((t) => t.startsWith("text/")) ||
          !!cd?.getData("text/plain");
        if (!hasText) {
          e.preventDefault();
          void tryTauriClipboard(view);
          return true;
        }

        return false;
      },
      // Drop handler (T2.5).
      drop: (e, view) => {
        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        const images = Array.from(files).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (images.length === 0) return false;
        e.preventDefault();
        // Move the cursor to the drop position so the insertion lands there.
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos != null) {
          view.dispatch({ selection: { anchor: pos } });
        }
        void (async () => {
          for (const file of images) {
            const rel = await persistAsset(file, file.type, file.name);
            if (rel) insertImageRef(rel, view);
          }
        })();
        setDragActive(false);
        return true;
      },
      dragenter: (e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          setDragActive(true);
        }
        return false;
      },
      dragover: (e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setDragActive(true);
        }
        return false;
      },
      dragleave: (e) => {
        // Only clear when leaving the editor entirely.
        const related = e.relatedTarget as Node | null;
        if (
          !related ||
          (hostRef.current && !hostRef.current.contains(related))
        ) {
          setDragActive(false);
        }
        return false;
      },
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        saveKeymap,
        EditorView.lineWrapping,
        markdown({ codeLanguages: languages }),
        wikilinkPlugin((slug) => onWikilinkRef.current?.(slug)),
        imageWidgetPlugin(() => dirOf(docPathRef.current)),
        livePreviewExtension({
          onOpenUrl: (url) => {
            // External URL → open in default OS browser
            if (/^https?:\/\//i.test(url)) {
              invoke("open_external_url", { url }).catch(console.error);
              return;
            }
            // Relative path (typically a sibling .md) → route through the
            // wikilink resolver so the viewer navigates in-app.
            const slug = url
              .replace(/\\/g, "/")
              .replace(/^\.\//, "")
              .replace(/\.md$/i, "");
            onWikilinkRef.current?.(slug);
          },
        }),
        pasteHandler,
        themeCompartment.of(theme ?? oneDark),
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    valueRef.current = value;
    lastSavedRef.current = value;

    return () => {
      cancelDebounce();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile external value changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
      valueRef.current = value;
      lastSavedRef.current = value;
      setStateAndNotify("saved");
    }
  }, [value]);

  // Reconfigure theme when prop changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(theme ?? oneDark),
    });
  }, [theme, themeCompartment]);

  const indicatorColor =
    saveState === "saved"
      ? "#4af076"
      : saveState === "saving"
      ? "#f0c44a"
      : "#888";
  const indicatorLabel =
    saveState === "saved"
      ? "Saved"
      : saveState === "saving"
      ? "Saving..."
      : "Unsaved";

  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div ref={hostRef} style={{ flex: 1, overflow: "auto" }} />
      {dragActive && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            border: "2px dashed var(--accent, #4a9eff)",
            background: "rgba(74,158,255,0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--accent, #4a9eff)",
            fontSize: 13,
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          }}
        >
          drop image to insert
        </div>
      )}
      <div
        style={{
          position: "absolute",
          right: 8,
          bottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 8px",
          fontSize: 11,
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          color: "var(--text-muted, #aaa)",
          background: "var(--bg-secondary, rgba(0,0,0,0.4))",
          border: "1px solid var(--border, #2a2a3a)",
          borderRadius: 4,
          pointerEvents: "none",
        }}
        aria-live="polite"
      >
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: indicatorColor,
          }}
        />
        <span>{indicatorLabel}</span>
      </div>
    </div>
  );
}

export default MarkdownEditor;
