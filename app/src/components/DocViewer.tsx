// Linear-style document viewer (F3). Body editor is CodeMirror 6 via
// MarkdownEditor; for `type: task` docs a properties rail and a relations
// panel surface the Beads-style task graph fields. All edits flow through
// the Tauri `update_frontmatter` command so frontmatter writes are atomic
// and cycle-checked.

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import MarkdownEditor, { SaveState } from "./MarkdownEditor";
import HoverPreview from "./HoverPreview";
import { OrgDocument, Relations, DocSummary } from "../types";
import { Theme } from "../themes";

interface Props {
  doc: OrgDocument;
  docs?: OrgDocument[];
  theme: Theme;
  onClose: () => void;
  onApprove?: (notes: string) => void;
  onSynthesize?: () => void;
  synthesizeRunning?: boolean;
  onDismiss?: () => void;
  onOpenUrl?: (url: string) => void;
  onNavigate?: (doc: OrgDocument) => void;
  onSpawnSwarm?: () => void;
}

const TASK_STATUSES = [
  "active",
  "blocked",
  "review",
  "paused",
  "backlog",
  "incubating",
  "complete",
];
const TASK_KINDS = ["task", "feature", "epic"];
const PRIORITIES = ["p0", "p1", "p2", "p3"];

function splitFrontmatter(raw: string): { prefix: string; body: string } {
  if (!raw.startsWith("---")) return { prefix: "", body: raw };
  const rest = raw.slice(3);
  const end = rest.indexOf("\n---");
  if (end === -1) return { prefix: "", body: raw };
  return {
    prefix: "---" + rest.slice(0, end) + "\n---\n",
    body: rest.slice(end + 4).replace(/^\n+/, ""),
  };
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

/** Build an editor theme that picks up the active org-viewer theme. */
function useEditorTheme(theme: Theme) {
  return useMemo(
    () =>
      EditorView.theme(
        {
          "&": {
            color: theme.text,
            backgroundColor: theme.bg,
            fontSize: "13px",
            height: "100%",
          },
          ".cm-content": {
            caretColor: theme.accent,
            fontFamily:
              "'Cascadia Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            padding: "16px 20px",
          },
          ".cm-gutters": {
            backgroundColor: theme.bg,
            color: theme.textDim,
            border: "none",
          },
          ".cm-cursor": { borderLeftColor: theme.accent },
          "&.cm-focused .cm-cursor": { borderLeftColor: theme.accent },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
            {
              backgroundColor: theme.accentMuted,
            },
          ".cm-activeLine": { backgroundColor: theme.bgSecondary },
          ".cm-activeLineGutter": { backgroundColor: theme.bgSecondary },
          ".cm-wikilink": {
            color: theme.accent,
            textDecoration: "none",
            borderBottom: `1px dashed ${theme.accent}`,
            cursor: "pointer",
          },
          ".cm-inline-image img": {
            border: `1px solid ${theme.border}`,
          },
        },
        { dark: true },
      ),
    [theme],
  );
}

function StatusDot({
  status,
  theme,
  ready,
}: {
  status?: string;
  theme: Theme;
  ready?: boolean;
}) {
  let color: string = theme.textDim;
  if (status === "complete") color = theme.textDim;
  else if (status === "active") color = ready === false ? theme.warning : theme.success;
  else if (status === "blocked") color = theme.warning;
  else if (status === "paused") color = theme.textMuted;
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

function RelationRow({
  item,
  theme,
  onNavigate,
}: {
  item: DocSummary;
  theme: Theme;
  onNavigate: (path: string) => void;
}) {
  return (
    <button
      onClick={() => onNavigate(item.path)}
      data-doc-path={item.path}
      className="w-full flex items-center gap-2 px-2 py-1 rounded text-left text-xs"
      style={{
        background: "transparent",
        color: theme.text,
        border: `1px solid ${theme.border}`,
      }}
    >
      <StatusDot status={item.status} theme={theme} />
      <span className="flex-1 truncate">{item.title}</span>
      {item.kind && item.kind !== "task" && (
        <span
          style={{
            fontSize: 9,
            padding: "1px 5px",
            borderRadius: 3,
            background: theme.accentMuted,
            color: theme.accent,
            textTransform: "uppercase",
          }}
        >
          {item.kind}
        </span>
      )}
      {item.priority && (
        <span style={{ fontSize: 10, color: theme.textDim }}>
          {item.priority}
        </span>
      )}
    </button>
  );
}

function RelationGroup({
  label,
  items,
  theme,
  onNavigate,
}: {
  label: string;
  items: DocSummary[];
  theme: Theme;
  onNavigate: (path: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span
        className="text-xs font-semibold"
        style={{ color: theme.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}
      >
        {label} · {items.length}
      </span>
      <div className="flex flex-col gap-1">
        {items.map((it) => (
          <RelationRow
            key={it.path}
            item={it}
            theme={theme}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}

export default function DocViewer({
  doc,
  docs,
  theme,
  onClose,
  onApprove,
  onSynthesize,
  synthesizeRunning,
  onDismiss,
  onOpenUrl,
  onNavigate,
  onSpawnSwarm,
}: Props) {
  const isTask = doc.type === "task";
  const [body, setBody] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [notes, setNotes] = useState("");
  const [approved, setApproved] = useState(false);
  const [synthesized, setSynthesized] = useState(false);
  const [relations, setRelations] = useState<Relations | null>(null);
  const [propsOpen, setPropsOpen] = useState(true);
  const prefixRef = useRef("");

  const editorTheme = useEditorTheme(theme);

  const backlinks = useMemo(() => {
    if (!docs) return [];
    const slug = doc.filename.replace(/\.md$/, "");
    // If multiple docs share this basename (e.g. many README.md across
    // projects), bare wikilinks like `[[README]]` are ambiguous and must
    // not be attributed to a specific target. Only count path-shaped
    // wikilinks whose final segment resolves to this doc's path.
    const basenameIsUnique =
      docs.filter((d) => d.filename === doc.filename).length <= 1;
    const targetPath = doc.path.replace(/\\/g, "/");
    return docs.filter((d) => {
      if (d.path === doc.path) return false;
      return d.links.some((raw) => {
        const l = raw.trim();
        const base = l.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? "";
        if (base !== slug && l !== slug) return false;
        const isPathShaped = l.includes("/") || l.includes("\\");
        if (isPathShaped) {
          // Resolve relative to source dir; match if it lands on this doc.
          const sourceDir = d.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
          const norm = l.replace(/\\/g, "/").replace(/\.md$/, "");
          const candidate = norm.startsWith("/")
            ? norm + ".md"
            : `${sourceDir}/${norm}.md`;
          return candidate.toLowerCase() === targetPath.toLowerCase() ||
                 targetPath.toLowerCase().endsWith("/" + norm.toLowerCase() + ".md");
        }
        // Bare slug — only attribute when basename is unique in the org.
        return basenameIsUnique;
      });
    });
  }, [docs, doc.filename, doc.path]);

  // Load raw file content. Re-run when the doc switches.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    invoke<string>("read_file", { path: doc.path })
      .then((raw) => {
        if (cancelled) return;
        const { prefix, body } = splitFrontmatter(raw);
        prefixRef.current = prefix;
        setBody(body);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        prefixRef.current = "";
        setBody(doc.content);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [doc.path, doc.content]);

  // Pull relations for tasks (and any doc with task-graph fields).
  const refreshRelations = useCallback(() => {
    if (!isTask) {
      setRelations(null);
      return;
    }
    invoke<Relations | null>("get_relations", { path: doc.path })
      .then((r) => setRelations(r))
      .catch(() => setRelations(null));
  }, [doc.path, isTask]);

  useEffect(() => {
    refreshRelations();
  }, [refreshRelations]);

  const doSave = useCallback(
    async (next: string) => {
      const content = prefixRef.current
        ? prefixRef.current + "\n" + next
        : next;
      await invoke("write_file", { path: doc.path, content });
    },
    [doc.path],
  );

  const patchFrontmatter = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        await invoke("update_frontmatter", { path: doc.path, patch });
        // Re-read so the prefix stays in sync with disk.
        const raw = await invoke<string>("read_file", { path: doc.path });
        const { prefix } = splitFrontmatter(raw);
        prefixRef.current = prefix;
        refreshRelations();
      } catch (err) {
        console.error("update_frontmatter failed", err);
      }
    },
    [doc.path, refreshRelations],
  );


  const ready = relations?.ready ?? true;
  const synthesizeDisabled = synthesized || synthesizeRunning;
  const headerAccent =
    isTask && doc.status === "active" && !ready
      ? theme.warning
      : theme.accent;

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: theme.bg, color: theme.text }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b text-sm flex-shrink-0"
        style={{
          background: theme.bgTertiary,
          borderColor: theme.border,
          borderLeft: isTask ? `3px solid ${headerAccent}` : undefined,
        }}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {isTask && <StatusDot status={doc.status} theme={theme} ready={ready} />}
          <div className="flex flex-col min-w-0 flex-1">
            <span
              className="font-semibold truncate"
              style={{ color: theme.text, lineHeight: 1.2 }}
              title={doc.path}
            >
              {doc.title}
            </span>
            <span
              className="truncate"
              style={{
                color: theme.textDim,
                fontSize: 10,
                fontFamily:
                  "Cascadia Code, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                lineHeight: 1.2,
                marginTop: 1,
                cursor: "pointer",
                userSelect: "all",
              }}
              title="click to copy path"
              onClick={() => {
                try { navigator.clipboard?.writeText(doc.path); } catch { /* ignore */ }
              }}
            >
              {doc.path.replace(/\\/g, "/")}
            </span>
          </div>
          {doc.kind && doc.kind !== "task" && (
            <span
              style={{
                fontSize: 9,
                padding: "2px 6px",
                borderRadius: 3,
                background: theme.accentMuted,
                color: theme.accent,
                textTransform: "uppercase",
                flexShrink: 0,
              }}
            >
              {doc.kind}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {(isTask || doc.status) && (
            <span
              className="text-xs px-2 py-0.5 rounded"
              style={{ background: theme.accentMuted, color: theme.accent }}
              title="Status — change in the properties panel below"
            >
              {doc.status ?? "active"}
            </span>
          )}
          {isTask && onSpawnSwarm && (
            <button
              onClick={onSpawnSwarm}
              className="text-xs px-2 py-0.5 rounded cursor-pointer flex items-center gap-1"
              style={{
                background: theme.accent,
                color: theme.bg,
                border: "none",
                fontWeight: 500,
              }}
              title="Open this task in a swarm tile (sets status to active)"
            >
              <span style={{ fontSize: 11 }}>❯</span>
              <span>Send to swarm</span>
            </button>
          )}
          <span
            className="text-xs"
            style={{
              color:
                saveState === "saved"
                  ? theme.textDim
                  : saveState === "saving"
                  ? theme.warning
                  : theme.error,
            }}
          >
            {saveState === "saved"
              ? "saved"
              : saveState === "saving"
              ? "saving…"
              : "unsaved"}
          </span>
          {isTask && (
            <button
              onClick={() => setPropsOpen((v) => !v)}
              className="text-xs px-2 py-0.5 rounded"
              style={{
                background: theme.bgTertiary,
                color: theme.textDim,
                border: `1px solid ${theme.border}`,
              }}
              title={propsOpen ? "Hide properties" : "Show properties"}
            >
              {propsOpen ? "‹‹" : "››"}
            </button>
          )}
          {onSynthesize && (
            <button
              onClick={() => {
                if (synthesizeDisabled) return;
                setSynthesized(true);
                onSynthesize();
              }}
              disabled={synthesizeDisabled}
              className="text-xs px-2 py-0.5 rounded"
              style={{
                background: synthesizeDisabled ? theme.bgTertiary : theme.accentMuted,
                color: synthesizeDisabled ? theme.textDim : theme.accent,
                border: `1px solid ${theme.border}`,
                cursor: synthesizeDisabled ? "not-allowed" : "pointer",
              }}
              title="Distill into knowledge base, then archive"
            >
              {synthesizeDisabled ? "Synthesizing…" : "Synthesize"}
            </button>
          )}
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="text-xs px-2 py-0.5 rounded"
              style={{
                background: theme.bgTertiary,
                color: theme.textDim,
                border: `1px solid ${theme.border}`,
              }}
              title="Archive this item"
            >
              Archive
            </button>
          )}
          <button
            onClick={onClose}
            className="text-xs"
            style={{ color: theme.textDim }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Body + properties rail */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0">
          {!loading && (
            <MarkdownEditor
              value={body}
              docPath={doc.path}
              theme={editorTheme}
              onSave={doSave}
              onStateChange={setSaveState}
              onWikilinkNavigate={(slug) => {
                if (!docs || !onNavigate) return;
                const target = docs.find((d) => {
                  const base = d.filename.replace(/\.md$/, "");
                  return (
                    base === slug ||
                    d.path.replace(/\\/g, "/").endsWith(`/${slug}.md`)
                  );
                });
                if (target) onNavigate(target);
                else if (onOpenUrl && /^https?:\/\//i.test(slug))
                  onOpenUrl(slug);
              }}
            />
          )}
        </div>

        {isTask && propsOpen && (
          <PropertiesRail
            doc={doc}
            theme={theme}
            relations={relations}
            docs={docs}
            patchFrontmatter={patchFrontmatter}
            onNavigate={(p) => {
              const target = docs?.find((d) => d.path === p);
              if (target && onNavigate) onNavigate(target);
            }}
          />
        )}
      </div>

      {/* Approval panel (inbox/decision docs) */}
      {onApprove && (
        <div
          className="flex flex-col gap-2 px-4 py-3 border-t flex-shrink-0"
          style={{ borderColor: theme.border, background: theme.bgSecondary }}
        >
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Answer open questions or add context for the agent… (optional)"
            rows={3}
            className="w-full resize-none rounded px-2 py-1.5 text-xs outline-none"
            style={{
              background: theme.bgTertiary,
              color: theme.text,
              border: `1px solid ${theme.border}`,
              fontFamily: "inherit",
              lineHeight: 1.6,
            }}
          />
          <div className="flex justify-end">
            <button
              onClick={() => {
                if (approved) return;
                setApproved(true);
                onApprove(notes);
              }}
              disabled={approved}
              className="text-xs px-3 py-1 rounded font-medium"
              style={{
                background: approved ? theme.bgTertiary : theme.accent,
                color: approved ? theme.textDim : theme.bg,
                cursor: approved ? "not-allowed" : "pointer",
              }}
            >
              {approved ? "Spawned ✓" : "Approve ❯"}
            </button>
          </div>
        </div>
      )}

      {/* Tags footer */}
      {doc.tags.length > 0 && (
        <div
          className="flex items-center gap-2 px-4 py-2 border-t flex-shrink-0 flex-wrap"
          style={{ borderColor: theme.border, background: theme.bgSecondary }}
        >
          {doc.tags.map((t) => (
            <span
              key={t}
              className="text-xs px-2 py-0.5 rounded"
              style={{ background: theme.accentMuted, color: theme.accent }}
            >
              #{t}
            </span>
          ))}
        </div>
      )}

      {/* Backlinks panel */}
      {backlinks.length > 0 && (
        <BacklinksPanel
          backlinks={backlinks}
          theme={theme}
          onNavigate={onNavigate}
        />
      )}
      {docs && <HoverPreview docs={docs} theme={theme} />}
    </div>
  );
}

function BacklinksPanel({
  backlinks,
  theme,
  onNavigate,
}: {
  backlinks: OrgDocument[];
  theme: Theme;
  onNavigate?: (doc: OrgDocument) => void;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    return localStorage.getItem("propsRail.backlinks.open") === "1";
  });
  useEffect(() => {
    localStorage.setItem("propsRail.backlinks.open", open ? "1" : "0");
  }, [open]);
  return (
    <div
      className="flex flex-col gap-1 px-4 py-2 border-t flex-shrink-0"
      style={{ borderColor: theme.border, background: theme.bgSecondary }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-semibold text-left"
        style={{
          color: theme.textDim,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
        }}
      >
        {open ? "▾" : "▸"} {backlinks.length} backlink
        {backlinks.length !== 1 ? "s" : ""}
      </button>
      {open && (
        <div className="flex flex-wrap gap-1">
          {backlinks.map((b) => (
            <button
              key={b.path}
              onClick={() => onNavigate?.(b)}
              className="text-xs px-2 py-0.5 rounded"
              style={{
                background: theme.bgTertiary,
                color: theme.accent,
                border: `1px solid ${theme.border}`,
                cursor: "pointer",
              }}
            >
              {b.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- Properties rail ----------------

function PropertiesRail({
  doc,
  theme,
  relations,
  docs,
  patchFrontmatter,
  onNavigate,
}: {
  doc: OrgDocument;
  theme: Theme;
  relations: Relations | null;
  docs?: OrgDocument[];
  patchFrontmatter: (patch: Record<string, unknown>) => Promise<void>;
  onNavigate: (path: string) => void;
}) {
  const [parentSearch, setParentSearch] = useState("");
  const [blockedBySearch, setBlockedBySearch] = useState("");
  const [showParentPicker, setShowParentPicker] = useState(false);
  const [showBlockedByPicker, setShowBlockedByPicker] = useState(false);

  const RAIL_MIN = 220;
  const RAIL_MAX = 460;
  const RAIL_DEFAULT = 280;
  const [railWidth, setRailWidth] = useState<number>(() => {
    const saved = localStorage.getItem("propsRailWidth");
    const n = saved ? parseInt(saved, 10) : NaN;
    if (Number.isFinite(n)) return Math.max(RAIL_MIN, Math.min(RAIL_MAX, n));
    return RAIL_DEFAULT;
  });
  useEffect(() => {
    localStorage.setItem("propsRailWidth", String(railWidth));
  }, [railWidth]);
  const railDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const handleRailDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    railDragRef.current = { startX: e.clientX, startW: railWidth };
    const onMove = (ev: MouseEvent) => {
      if (!railDragRef.current) return;
      // Dragging left grows the rail (rail is on the right side).
      const next = Math.max(
        RAIL_MIN,
        Math.min(
          RAIL_MAX,
          railDragRef.current.startW - (ev.clientX - railDragRef.current.startX),
        ),
      );
      setRailWidth(next);
    };
    const onUp = () => {
      railDragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Autosize Acceptance textarea
  const acceptanceRef = useRef<HTMLTextAreaElement | null>(null);
  const autosizeAcceptance = useCallback(() => {
    const el = acceptanceRef.current;
    if (!el) return;
    el.style.height = "auto";
    const min = 3 * 16; // ~3rem (2 rows + padding)
    const max = 18 * 16; // ~18rem (~12 rows)
    const next = Math.max(min, Math.min(max, el.scrollHeight));
    el.style.height = next + "px";
  }, []);
  useEffect(() => {
    autosizeAcceptance();
  }, [autosizeAcceptance, doc.path]);

  // Mentioned by collapse state
  const [mentionedByOpen, setMentionedByOpen] = useState<boolean>(() => {
    return localStorage.getItem("propsRail.mentionedBy.open") === "1";
  });
  useEffect(() => {
    localStorage.setItem(
      "propsRail.mentionedBy.open",
      mentionedByOpen ? "1" : "0",
    );
  }, [mentionedByOpen]);

  const taskDocs = useMemo(() => docs?.filter((d) => d.type === "task") ?? [], [docs]);

  const parentDoc = useMemo(() => {
    if (!doc.parent) return null;
    return (
      relations?.parent ??
      taskDocs.find((d) => d.path === doc.parent || d.filename === doc.parent!.split("/").pop()) ?? null
    );
  }, [doc.parent, relations, taskDocs]);

  return (
    <aside
      className="flex flex-col gap-4 border-l overflow-y-auto flex-shrink-0"
      style={{
        width: railWidth,
        borderColor: theme.border,
        background: theme.bgSecondary,
        padding: "12px 14px",
        position: "relative",
      }}
    >
      {/* Drag handle — left edge */}
      <div
        onMouseDown={handleRailDragStart}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: 5,
          cursor: "ew-resize",
          zIndex: 10,
        }}
        title="Drag to resize"
      />
      <PropField label="Status" theme={theme}>
        <select
          value={doc.status ?? "active"}
          onChange={(e) => {
            const next = e.target.value;
            const patch: Record<string, unknown> = { status: next };
            if (next === "complete") patch.completed = today();
            else patch.completed = null;
            void patchFrontmatter(patch);
          }}
          className="text-xs w-full px-2 py-1 rounded"
          style={selectStyle(theme)}
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </PropField>

      <PropField label="Kind" theme={theme}>
        <select
          value={doc.kind ?? "task"}
          onChange={(e) =>
            void patchFrontmatter({
              kind: e.target.value === "task" ? null : e.target.value,
            })
          }
          className="text-xs w-full px-2 py-1 rounded"
          style={selectStyle(theme)}
        >
          {TASK_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </PropField>

      <PropField label="Priority" theme={theme}>
        <select
          value={doc.priority ?? ""}
          onChange={(e) =>
            void patchFrontmatter({
              priority: e.target.value || null,
            })
          }
          className="text-xs w-full px-2 py-1 rounded"
          style={selectStyle(theme)}
        >
          <option value="">—</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </PropField>

      <PropField label="Due" theme={theme}>
        <input
          type="date"
          value={doc.due ?? ""}
          onChange={(e) =>
            void patchFrontmatter({ due: e.target.value || null })
          }
          className="text-xs w-full px-2 py-1 rounded"
          style={selectStyle(theme)}
        />
      </PropField>

      <PropField label="First action" theme={theme}>
        <input
          type="text"
          defaultValue={(doc.frontmatter["first-action"] as string) ?? ""}
          placeholder="One physical action…"
          onBlur={(e) =>
            void patchFrontmatter({
              "first-action": e.target.value.trim() || null,
            })
          }
          className="text-xs w-full px-2 py-1 rounded"
          style={contractStyle(theme)}
        />
      </PropField>

      <PropField label="Acceptance" theme={theme}>
        <textarea
          ref={acceptanceRef}
          defaultValue={
            (doc.frontmatter["acceptance-criteria"] as string) ?? ""
          }
          placeholder="Observable runtime behavior…"
          onInput={autosizeAcceptance}
          onBlur={(e) =>
            void patchFrontmatter({
              "acceptance-criteria": e.target.value.trim() || null,
            })
          }
          className="text-xs w-full px-2 py-1 rounded"
          style={{
            ...contractStyle(theme),
            minHeight: "3rem",
            maxHeight: "18rem",
            resize: "vertical",
            overflow: "auto",
            lineHeight: 1.5,
          }}
        />
      </PropField>

      <PropField label="Parent" theme={theme}>
        {parentDoc ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onNavigate(parentDoc.path)}
              className="flex-1 text-xs px-2 py-1 rounded text-left truncate"
              style={selectStyle(theme)}
            >
              {parentDoc.title}
            </button>
            <button
              onClick={() => void patchFrontmatter({ parent: null })}
              className="text-xs px-2 py-1 rounded"
              style={{ color: theme.textDim, background: "transparent" }}
              title="Clear parent"
            >
              ✕
            </button>
          </div>
        ) : showParentPicker ? (
          <PickerInput
            value={parentSearch}
            onChange={setParentSearch}
            options={taskDocs.filter((d) => d.path !== doc.path)}
            theme={theme}
            onPick={(picked) => {
              setShowParentPicker(false);
              setParentSearch("");
              void patchFrontmatter({ parent: picked.path });
            }}
            onCancel={() => {
              setShowParentPicker(false);
              setParentSearch("");
            }}
          />
        ) : (
          <button
            onClick={() => setShowParentPicker(true)}
            className="text-xs w-full px-2 py-1 rounded text-left"
            style={{
              ...selectStyle(theme),
              color: theme.textDim,
              borderStyle: "dashed",
            }}
          >
            + set parent
          </button>
        )}
      </PropField>

      <PropField
        label={`Blocked by · ${relations?.blockedBy.length ?? 0}`}
        theme={theme}
      >
        <div className="flex flex-col gap-1">
          {relations?.blockedBy.map((b) => (
            <div key={b.path} className="flex items-center gap-1">
              <RelationRow item={b} theme={theme} onNavigate={onNavigate} />
              <button
                onClick={() => {
                  const next = (doc.blockedBy ?? []).filter(
                    (p) => !pathMatches(p, b.path, b.title),
                  );
                  void patchFrontmatter({ "blocked-by": next });
                }}
                className="text-xs px-2 rounded"
                style={{ color: theme.textDim, background: "transparent" }}
                title="Remove blocker"
              >
                ✕
              </button>
            </div>
          ))}
          {showBlockedByPicker ? (
            <PickerInput
              value={blockedBySearch}
              onChange={setBlockedBySearch}
              options={taskDocs.filter(
                (d) =>
                  d.path !== doc.path &&
                  !(doc.blockedBy ?? []).some((p) =>
                    pathMatches(p, d.path, d.title),
                  ),
              )}
              theme={theme}
              onPick={(picked) => {
                setShowBlockedByPicker(false);
                setBlockedBySearch("");
                const next = [...(doc.blockedBy ?? []), picked.path];
                void patchFrontmatter({ "blocked-by": next });
              }}
              onCancel={() => {
                setShowBlockedByPicker(false);
                setBlockedBySearch("");
              }}
            />
          ) : (
            <button
              onClick={() => setShowBlockedByPicker(true)}
              className="text-xs px-2 py-1 rounded text-left"
              style={{
                ...selectStyle(theme),
                color: theme.textDim,
                borderStyle: "dashed",
              }}
            >
              + add blocker
            </button>
          )}
        </div>
      </PropField>

      {relations && (
        <div className="flex flex-col gap-3 mt-2 pt-3" style={{ borderTop: `1px solid ${theme.border}` }}>
          <RelationGroup
            label="Children"
            items={relations.children}
            theme={theme}
            onNavigate={onNavigate}
          />
          <RelationGroup
            label="Blocks"
            items={relations.blocks}
            theme={theme}
            onNavigate={onNavigate}
          />
          <RelationGroup
            label="Relates to"
            items={relations.relatesTo}
            theme={theme}
            onNavigate={onNavigate}
          />
          <RelationGroup
            label="Referenced by"
            items={relations.referencedBy}
            theme={theme}
            onNavigate={onNavigate}
          />
          {relations.mentionedBy.length > 0 && (
            <div className="flex flex-col gap-1">
              <button
                onClick={() => setMentionedByOpen((v) => !v)}
                className="text-xs font-semibold text-left"
                style={{
                  color: theme.textDim,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                }}
              >
                {mentionedByOpen ? "▾" : "▸"} Mentioned by ·{" "}
                {relations.mentionedBy.length}
              </button>
              {mentionedByOpen && (
                <div className="flex flex-col gap-1">
                  {relations.mentionedBy.map((it) => (
                    <RelationRow
                      key={it.path}
                      item={it}
                      theme={theme}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function PropField({
  label,
  theme,
  children,
}: {
  label: string;
  theme: Theme;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className="text-xs"
        style={{
          color: theme.textDim,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          fontSize: 10,
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function selectStyle(theme: Theme): React.CSSProperties {
  return {
    background: theme.bgTertiary,
    color: theme.text,
    border: `1px solid ${theme.border}`,
    outline: "none",
    fontFamily: "inherit",
  };
}

/** "Contract" styling for the load-bearing First action / Acceptance fields:
 *  monospace + slightly inset background so they read as code/spec rather
 *  than just another form field. */
function contractStyle(theme: Theme): React.CSSProperties {
  return {
    background: theme.bg,
    color: theme.text,
    border: `1px solid ${theme.border}`,
    outline: "none",
    fontFamily: "'Cascadia Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  };
}

function PickerInput({
  value,
  onChange,
  options,
  theme,
  onPick,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: OrgDocument[];
  theme: Theme;
  onPick: (doc: OrgDocument) => void;
  onCancel: () => void;
}) {
  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    const sorted = [...options].sort((a, b) => a.title.localeCompare(b.title));
    if (!q) return sorted.slice(0, 12);
    return sorted
      .filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.filename.toLowerCase().includes(q) ||
          d.path.toLowerCase().replace(/\\/g, "/").includes(q),
      )
      .slice(0, 12);
  }, [value, options]);

  return (
    <div className="flex flex-col gap-1">
      <input
        autoFocus
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && filtered[0]) onPick(filtered[0]);
        }}
        placeholder="search…"
        className="text-xs w-full px-2 py-1 rounded"
        style={selectStyle(theme)}
      />
      <div className="flex flex-col gap-0.5 max-h-60 overflow-y-auto">
        {filtered.map((d) => (
          <button
            key={d.path}
            onClick={() => onPick(d)}
            className="text-xs px-2 py-1 rounded text-left"
            style={selectStyle(theme)}
            title={d.path}
          >
            <div className="truncate">{d.title}</div>
            <div
              className="truncate"
              style={{
                color: theme.textDim,
                fontSize: 9,
                fontFamily:
                  "Cascadia Code, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              }}
            >
              {d.path.replace(/\\/g, "/")}
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <span className="text-xs px-2" style={{ color: theme.textDim }}>
            no matches
          </span>
        )}
      </div>
    </div>
  );
}

/** Loose path comparison for blocked-by removal. The frontmatter may store
 *  any of: full path, basename, slug. Match on basename/slug when full
 *  paths differ. */
function pathMatches(stored: string, fullPath: string, title?: string): boolean {
  const s = stored.replace(/\\/g, "/").trim();
  const f = fullPath.replace(/\\/g, "/").trim();
  if (s === f) return true;
  const base = f.split("/").pop() ?? "";
  const slug = base.replace(/\.md$/, "");
  const sBase = s.split("/").pop() ?? "";
  const sSlug = sBase.replace(/\.md$/, "");
  if (sBase === base || sSlug === slug) return true;
  if (title && s === title) return true;
  return false;
}
