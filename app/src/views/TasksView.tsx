// Linear-style tasks view (F4). Task list supports:
//   - status-icon click-to-cycle (T4.1)
//   - j/k navigate, s cycle, p set priority, c create, / focus search (T4.2)
//   - group-by toggle: status / priority / parent / kind (T4.3)
//   - ready-work filter (T4.4): hides tasks whose blockers are still open
//   - saved views in localStorage (T4.5)

import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ViewProps } from "../components/ViewProps";
import DocViewer from "../components/DocViewer";
import { OrgDocument } from "../types";
import { AGENT_STYLE, useAgentKaomoji } from "../hooks/useAgentKaomoji";
import { isReady as isReadyShared, type TaskIndexes } from "../lib/taskGraph";

const STATUS_ORDER = [
  "active",
  "blocked",
  "review",
  "paused",
  "backlog",
  "incubating",
  "complete",
];
const PRIORITY_ORDER = ["p0", "p1", "p2", "p3", ""];
const KIND_ORDER = ["epic", "feature", "task"];

// Project name extracted from the leading "ProjectName: " segment of the
// task title. systema-claude ships no preset project taxonomy — the user
// develops their own through use.
function extractProject(doc: OrgDocument): string {
  const titleMatch = doc.title.match(/^([A-Za-z][A-Za-z0-9\-\.]+):\s/);
  if (titleMatch) {
    return titleMatch[1].toLowerCase().replace(/\./g, "-");
  }
  return "other";
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "untitled"
  );
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

const MIN_LIST_W = 200;
const MAX_LIST_W = 720;
const DEFAULT_LIST_W = 380;

type GroupBy = "status" | "priority" | "parent" | "kind";

interface SavedView {
  name: string;
  filter: string;
  projectFilter: string;
  groupBy: GroupBy;
  readyOnly: boolean;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isReady(task: OrgDocument, byPath: Map<string, OrgDocument>, bySlug: Map<string, OrgDocument>): boolean {
  return isReadyShared(task, { byPath, bySlug } as TaskIndexes);
}

const STATUS_CYCLE = ["active", "blocked", "complete"];

export default function TasksView({
  docs,
  theme,
  orgRoot,
  selectedDoc,
  setSelectedDoc,
  onSpawnClaude,
  onOpenUrl,
  activePaths,
}: ViewProps) {
  const [filter, setFilter] = useState<string>(
    () => localStorage.getItem("tasks.filter") ?? "active",
  );
  const [projectFilter, setProjectFilter] = useState<string>(
    () => localStorage.getItem("tasks.projectFilter") ?? "all",
  );
  const [groupBy, setGroupBy] = useState<GroupBy>(
    () => (localStorage.getItem("tasks.groupBy") as GroupBy | null) ?? "status",
  );
  const [readyOnly, setReadyOnly] = useState<boolean>(
    () => localStorage.getItem("tasks.readyOnly") === "true",
  );
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const hasActive = activePaths != null && activePaths.size > 0;
  const kaomoji = useAgentKaomoji(hasActive);

  const [savedViews, setSavedViews] = useState<SavedView[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("tasks.savedViews") ?? "[]");
    } catch {
      return [];
    }
  });
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [viewsMenuOpen, setViewsMenuOpen] = useState(false);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const viewsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!groupMenuOpen && !viewsMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (groupMenuOpen && groupMenuRef.current && !groupMenuRef.current.contains(t)) {
        setGroupMenuOpen(false);
      }
      if (viewsMenuOpen && viewsMenuRef.current && !viewsMenuRef.current.contains(t)) {
        setViewsMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setGroupMenuOpen(false);
        setViewsMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [groupMenuOpen, viewsMenuOpen]);

  const [listWidth, setListWidth] = useState(() => {
    const saved = localStorage.getItem("tasksListWidth");
    return saved ? Number(saved) : DEFAULT_LIST_W;
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    localStorage.setItem("tasksListWidth", String(listWidth));
  }, [listWidth]);
  useEffect(() => {
    localStorage.setItem("tasks.filter", filter);
  }, [filter]);
  useEffect(() => {
    localStorage.setItem("tasks.projectFilter", projectFilter);
  }, [projectFilter]);
  useEffect(() => {
    localStorage.setItem("tasks.groupBy", groupBy);
  }, [groupBy]);
  useEffect(() => {
    localStorage.setItem("tasks.readyOnly", String(readyOnly));
  }, [readyOnly]);
  useEffect(() => {
    localStorage.setItem("tasks.savedViews", JSON.stringify(savedViews));
  }, [savedViews]);

  const allTasks = useMemo(() => docs.filter((d) => d.type === "task"), [docs]);

  // Indexes for ready-work resolution.
  const indexes = useMemo(() => {
    const byPath = new Map<string, OrgDocument>();
    const bySlug = new Map<string, OrgDocument>();
    for (const d of allTasks) {
      byPath.set(d.path, d);
      byPath.set(d.path.replace(/\\/g, "/"), d);
      const slug = d.filename.replace(/\.md$/, "");
      bySlug.set(slug, d);
    }
    return { byPath, bySlug };
  }, [allTasks]);

  const projects = useMemo(() => {
    const seen = new Set<string>();
    allTasks.forEach((d) => seen.add(extractProject(d)));
    const sorted = Array.from(seen).filter((p) => p !== "other").sort();
    if (seen.has("other")) sorted.push("other");
    return ["all", ...sorted];
  }, [allTasks]);

  const tasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allTasks
      .filter((d) => filter === "all" || d.status === filter)
      .filter((d) => projectFilter === "all" || extractProject(d) === projectFilter)
      .filter((d) => !q || d.title.toLowerCase().includes(q) || d.tags.some((t) => t.toLowerCase().includes(q)))
      .filter((d) => {
        if (!readyOnly) return true;
        if (d.kind === "epic") return false; // epics are containers
        if (d.status !== "active") return false;
        return isReady(d, indexes.byPath, indexes.bySlug);
      })
      .sort((a, b) => {
        const ai = STATUS_ORDER.indexOf(a.status ?? "");
        const bi = STATUS_ORDER.indexOf(b.status ?? "");
        if (ai !== bi) return ai - bi;
        // Secondary: priority
        const ap = PRIORITY_ORDER.indexOf(a.priority ?? "");
        const bp = PRIORITY_ORDER.indexOf(b.priority ?? "");
        if (ap !== bp) return ap - bp;
        // Tertiary: time descending (newest on top within same status+priority).
        // Prefer `updated` so a task edited today floats above one merely
        // created today.
        const at = a.updated ?? a.created ?? "";
        const bt = b.updated ?? b.created ?? "";
        if (at !== bt) return bt.localeCompare(at);
        // Stable tiebreaker on path desc.
        return b.path.localeCompare(a.path);
      });
  }, [allTasks, filter, projectFilter, readyOnly, indexes, search]);

  // Group tasks for display.
  const grouped = useMemo(() => {
    const groups = new Map<string, OrgDocument[]>();
    const keyOf = (d: OrgDocument): string => {
      switch (groupBy) {
        case "status":
          return d.status ?? "—";
        case "priority":
          return d.priority ?? "—";
        case "kind":
          return d.kind ?? "task";
        case "parent": {
          if (!d.parent) return "—";
          const base = d.parent.split(/[\\/]/).pop() ?? d.parent;
          return base.replace(/\.md$/, "");
        }
      }
    };
    for (const d of tasks) {
      const k = keyOf(d);
      const arr = groups.get(k) ?? [];
      arr.push(d);
      groups.set(k, arr);
    }
    const order = (k: string) => {
      if (groupBy === "status") return STATUS_ORDER.indexOf(k);
      if (groupBy === "priority") return PRIORITY_ORDER.indexOf(k);
      if (groupBy === "kind") return KIND_ORDER.indexOf(k);
      return 0;
    };
    return Array.from(groups.entries()).sort(
      ([a], [b]) => order(a) - order(b) || a.localeCompare(b),
    );
  }, [tasks, groupBy]);

  const filters = ["active", "blocked", "paused", "complete", "all"];

  const cycleStatus = useCallback(
    async (doc: OrgDocument) => {
      const cur = doc.status ?? "active";
      const idx = STATUS_CYCLE.indexOf(cur);
      const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
      const patch: Record<string, unknown> = { status: next };
      if (next === "complete") patch.completed = today();
      else patch.completed = null;
      try {
        await invoke("update_frontmatter", { path: doc.path, patch });
      } catch (err) {
        console.error("update_frontmatter failed", err);
      }
    },
    [],
  );

  const setPriority = useCallback(async (doc: OrgDocument) => {
    const cur = doc.priority ?? "";
    const i = PRIORITY_ORDER.indexOf(cur);
    const next = PRIORITY_ORDER[(i + 1) % PRIORITY_ORDER.length];
    try {
      await invoke("update_frontmatter", {
        path: doc.path,
        patch: { priority: next || null },
      });
    } catch (err) {
      console.error("update_frontmatter failed", err);
    }
  }, []);

  const handleCreate = useCallback(async () => {
    const title = newTitle.trim();
    if (!title || !orgRoot) return;
    setSaving(true);
    try {
      const slug = slugify(title);
      const sep = orgRoot.includes("\\") ? "\\" : "/";
      const path = `${orgRoot}${sep}tasks${sep}${slug}.md`;
      const content = `---
type: task
status: active
created: ${today()}
completed: null
tags: []
blocked-by: []
first-action: null
acceptance-criteria: null
---

# ${title}

## What



## Steps

- [ ]

`;
      await invoke("write_file", { path, content });
      setNewTitle("");
      setCreating(false);
    } finally {
      setSaving(false);
    }
  }, [newTitle, orgRoot]);

  // Keyboard shortcuts (T4.2). Skip when an input/textarea is focused.
  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        t.isContentEditable
      );
    };
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) {
        if (e.key === "Escape" && e.target === searchRef.current) {
          setSearch("");
          searchRef.current?.blur();
        }
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "c") {
        e.preventDefault();
        setCreating(true);
        return;
      }
      if (tasks.length === 0) return;
      const idx = selectedDoc
        ? tasks.findIndex((t) => t.path === selectedDoc.path)
        : -1;
      if (e.key === "j") {
        e.preventDefault();
        const next = tasks[Math.min(tasks.length - 1, idx + 1)] ?? tasks[0];
        setSelectedDoc(next);
        return;
      }
      if (e.key === "k") {
        e.preventDefault();
        const prev = tasks[Math.max(0, idx - 1)] ?? tasks[0];
        setSelectedDoc(prev);
        return;
      }
      if (!selectedDoc) return;
      if (e.key === "s") {
        e.preventDefault();
        void cycleStatus(selectedDoc);
      }
      if (e.key === "p") {
        e.preventDefault();
        void setPriority(selectedDoc);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tasks, selectedDoc, setSelectedDoc, cycleStatus, setPriority]);

  const handleSpawnClaude = (e: React.MouseEvent, doc: OrgDocument) => {
    e.stopPropagation();
    const agentId =
      typeof doc.frontmatter?.agent === "string" ? doc.frontmatter.agent : undefined;
    onSpawnClaude?.(doc.path, doc.title, undefined, agentId);
  };

  const handleStatusDotClick = (e: React.MouseEvent, doc: OrgDocument) => {
    e.stopPropagation();
    void cycleStatus(doc);
  };

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: listWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const next = Math.max(
        MIN_LIST_W,
        Math.min(
          MAX_LIST_W,
          dragRef.current.startW + ev.clientX - dragRef.current.startX,
        ),
      );
      setListWidth(next);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const saveCurrentView = () => {
    const name = window.prompt("Name this view:");
    if (!name) return;
    setSavedViews((views) => [
      ...views.filter((v) => v.name !== name),
      { name, filter, projectFilter, groupBy, readyOnly },
    ]);
  };

  const applyView = (v: SavedView) => {
    setFilter(v.filter);
    setProjectFilter(v.projectFilter);
    setGroupBy(v.groupBy);
    setReadyOnly(v.readyOnly);
  };

  const deleteView = (name: string) =>
    setSavedViews((views) => views.filter((v) => v.name !== name));

  return (
    <div className="flex h-full">
      <style>{AGENT_STYLE}</style>

      {/* Left: task list */}
      <div
        className="flex flex-col flex-shrink-0 border-r"
        style={{ width: listWidth, borderColor: theme.border, position: "relative" }}
      >
        {/* Compact toolbar + project strip */}
        <div
          className="flex flex-col flex-shrink-0"
          style={{ borderBottom: `1px solid ${theme.border}` }}
        >
          {/* Toolbar row 1: status segmented + dropdowns + ready + new */}
          <div
            className="flex items-center gap-1 px-2 flex-wrap"
            style={{ minHeight: 34, paddingTop: 4, paddingBottom: 4, color: theme.textDim }}
          >
            {/* Status segmented control */}
            <div
              className="flex items-center rounded flex-shrink-0"
              style={{
                background: theme.bgTertiary,
                border: `1px solid ${theme.border}`,
                padding: 1,
              }}
            >
              {filters.map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className="text-xs rounded"
                  style={{
                    padding: "2px 6px",
                    background: filter === f ? theme.accentMuted : "transparent",
                    color: filter === f ? theme.accent : theme.textDim,
                    fontSize: 11,
                  }}
                  title={f}
                >
                  {f === "complete" ? "done" : f === "blocked" ? "blkd" : f === "paused" ? "paus" : f}
                </button>
              ))}
            </div>

            {/* spacer */}
            <div style={{ flex: 1, minWidth: 0 }} />

            {/* Group dropdown */}
            <div ref={groupMenuRef} style={{ position: "relative" }}>
              <button
                onClick={() => {
                  setGroupMenuOpen((v) => !v);
                  setViewsMenuOpen(false);
                }}
                className="text-xs rounded"
                style={{
                  padding: "3px 6px",
                  background: theme.bgTertiary,
                  border: `1px solid ${theme.border}`,
                  color: theme.textDim,
                  fontSize: 11,
                  whiteSpace: "nowrap",
                }}
                title="Group by"
              >
                {groupBy} ▾
              </button>
              {groupMenuOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 2px)",
                    right: 0,
                    background: theme.bgSecondary,
                    border: `1px solid ${theme.border}`,
                    borderRadius: 4,
                    zIndex: 20,
                    minWidth: 110,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
                  }}
                >
                  {(["status", "priority", "parent", "kind"] as GroupBy[]).map((g) => (
                    <button
                      key={g}
                      onClick={() => {
                        setGroupBy(g);
                        setGroupMenuOpen(false);
                      }}
                      className="w-full text-left text-xs"
                      style={{
                        padding: "5px 10px",
                        background: groupBy === g ? theme.accentMuted : "transparent",
                        color: groupBy === g ? theme.accent : theme.text,
                        fontSize: 11,
                        display: "block",
                      }}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Views dropdown */}
            <div ref={viewsMenuRef} style={{ position: "relative" }}>
              <button
                onClick={() => {
                  setViewsMenuOpen((v) => !v);
                  setGroupMenuOpen(false);
                }}
                className="text-xs rounded"
                style={{
                  padding: "3px 6px",
                  background: theme.bgTertiary,
                  border: `1px solid ${theme.border}`,
                  color: theme.textDim,
                  fontSize: 11,
                  whiteSpace: "nowrap",
                }}
                title="Saved views"
              >
                views ▾
              </button>
              {viewsMenuOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 2px)",
                    right: 0,
                    background: theme.bgSecondary,
                    border: `1px solid ${theme.border}`,
                    borderRadius: 4,
                    zIndex: 20,
                    minWidth: 180,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
                  }}
                >
                  {savedViews.length === 0 && (
                    <div
                      style={{
                        padding: "5px 10px",
                        fontSize: 11,
                        color: theme.textDim,
                        fontStyle: "italic",
                      }}
                    >
                      no saved views
                    </div>
                  )}
                  {savedViews.map((v) => (
                    <div
                      key={v.name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        borderBottom: `1px solid ${theme.border}`,
                      }}
                    >
                      <button
                        onClick={() => {
                          applyView(v);
                          setViewsMenuOpen(false);
                        }}
                        className="text-left text-xs"
                        style={{
                          padding: "5px 10px",
                          color: theme.accent,
                          fontSize: 11,
                          flex: 1,
                          background: "transparent",
                        }}
                      >
                        {v.name}
                      </button>
                      <button
                        onClick={() => deleteView(v.name)}
                        style={{
                          padding: "5px 8px",
                          color: theme.textDim,
                          fontSize: 11,
                          background: "transparent",
                        }}
                        title="delete"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => {
                      saveCurrentView();
                      setViewsMenuOpen(false);
                    }}
                    className="w-full text-left text-xs"
                    style={{
                      padding: "5px 10px",
                      color: theme.textDim,
                      fontSize: 11,
                      background: "transparent",
                      display: "block",
                    }}
                  >
                    + save current
                  </button>
                </div>
              )}
            </div>

            {/* Ready toggle pill */}
            <button
              onClick={() => setReadyOnly((v) => !v)}
              className="text-xs rounded"
              style={{
                padding: "3px 8px",
                background: readyOnly ? theme.accentMuted : theme.bgTertiary,
                border: `1px solid ${readyOnly ? theme.accent : theme.border}`,
                color: readyOnly ? theme.accent : theme.textDim,
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
              title="Ready = active + all blockers complete"
            >
              ready
            </button>

            {/* New button */}
            <button
              onClick={() => setCreating(true)}
              className="text-xs rounded flex-shrink-0"
              style={{
                padding: "3px 8px",
                background: theme.accentMuted,
                color: theme.accent,
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
              title="New task (c)"
            >
              + new
            </button>
          </div>

          {/* Search row */}
          <div className="px-2" style={{ paddingBottom: 4 }}>
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search tasks… (/)"
              className="text-xs px-2 py-1 rounded outline-none w-full"
              style={{
                background: theme.bgTertiary,
                color: theme.text,
                border: `1px solid ${theme.border}`,
                height: 24,
              }}
            />
          </div>

          {/* Project strip — horizontal scroll */}
          {projects.length > 2 && (
            <div style={{ position: "relative", borderTop: `1px solid ${theme.border}` }}>
              <div
                className="flex items-center gap-1 px-2"
                style={{
                  height: 30,
                  overflowX: "auto",
                  overflowY: "hidden",
                  flexWrap: "nowrap",
                  scrollbarWidth: "none",
                }}
              >
                {projects.map((p) => (
                  <button
                    key={p}
                    onClick={() => setProjectFilter(p)}
                    className="text-xs rounded flex-shrink-0"
                    style={{
                      padding: "2px 8px",
                      background: projectFilter === p ? theme.accentMuted : "transparent",
                      color: projectFilter === p ? theme.accent : theme.textDim,
                      opacity: p === "other" ? 0.6 : 1,
                      fontSize: 11,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
              {/* Right-edge fade mask */}
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  bottom: 0,
                  width: 24,
                  pointerEvents: "none",
                  background: `linear-gradient(to right, transparent, ${theme.bg})`,
                }}
              />
            </div>
          )}
        </div>

        {/* New task form */}
        {creating && (
          <div
            className="p-2 border-b flex gap-2"
            style={{ borderColor: theme.border, background: theme.bgTertiary }}
          >
            <input
              ref={inputRef}
              type="text"
              placeholder="Task title..."
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewTitle("");
                }
              }}
              className="flex-1 bg-transparent text-sm outline-none px-2 py-1 rounded border"
              style={{ borderColor: theme.accent, color: theme.text }}
            />
            <button
              onClick={handleCreate}
              disabled={saving || !newTitle.trim()}
              className="text-xs px-2 py-1 rounded flex-shrink-0"
              style={{
                background: theme.accent,
                color: theme.bg,
                opacity: saving || !newTitle.trim() ? 0.5 : 1,
              }}
            >
              {saving ? "…" : "create"}
            </button>
            <button
              onClick={() => {
                setCreating(false);
                setNewTitle("");
              }}
              className="text-xs"
              style={{ color: theme.textDim }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Task list */}
        <div className="overflow-y-auto flex-1">
          {tasks.length === 0 ? (
            <div className="p-6 text-sm" style={{ color: theme.textDim }}>
              No matching tasks.
            </div>
          ) : (
            grouped.map(([groupKey, items]) => (
              <div key={groupKey}>
                <div
                  className={`px-3 py-0.5 text-xs font-semibold ${groupBy === "status" ? "sticky top-0 z-[1]" : ""}`}
                  style={{
                    background: theme.bgSecondary,
                    color: theme.textDim,
                    borderBottom: `1px solid ${theme.border}`,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  {groupKey} · {items.length}
                </div>
                {items.map((doc) => {
                  const isSelected = selectedDoc?.path === doc.path;
                  const isActive = activePaths?.has(doc.path) ?? false;
                  const ready = isReady(doc, indexes.byPath, indexes.bySlug);
                  const dotColor =
                    doc.status === "complete"
                      ? theme.textDim
                      : doc.status === "active"
                      ? ready
                        ? theme.success
                        : theme.warning
                      : doc.status === "blocked"
                      ? theme.warning
                      : theme.textMuted;
                  return (
                    <button
                      key={doc.path}
                      onClick={() => setSelectedDoc(doc)}
                      className="w-full flex items-start gap-3 px-4 py-2.5 text-left text-sm border-b"
                      style={{
                        background: isSelected ? theme.accentMuted : "transparent",
                        borderColor: theme.border,
                        color: theme.text,
                      }}
                    >
                      {/* Status dot — click to cycle (T4.1) */}
                      <span
                        onClick={(e) => handleStatusDotClick(e, doc)}
                        className="flex-shrink-0 mt-0.5"
                        style={{
                          position: "relative",
                          width: 10,
                          height: 10,
                          cursor: "pointer",
                        }}
                        title={`${doc.status ?? "active"} — click to cycle`}
                      >
                        {isActive ? (
                          <>
                            <span
                              style={{
                                position: "absolute",
                                inset: 0,
                                borderRadius: "50%",
                                background: theme.accent,
                                animation: "agentRing 1.2s ease-out infinite",
                              }}
                            />
                            <span
                              style={{
                                position: "absolute",
                                inset: 0,
                                borderRadius: "50%",
                                background: theme.accent,
                                animation: "agentPulse 1.2s ease-in-out infinite",
                              }}
                            />
                          </>
                        ) : (
                          <span
                            style={{
                              position: "absolute",
                              inset: 0,
                              borderRadius: "50%",
                              background: dotColor,
                              border:
                                doc.status === "active" && !ready
                                  ? `1px solid ${theme.warning}`
                                  : "none",
                            }}
                          />
                        )}
                      </span>

                      {/* Title + meta */}
                      <span className="flex-1 flex flex-col gap-0.5 overflow-hidden">
                        <span
                          style={{
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                            lineHeight: "1.35",
                            fontSize: 13,
                            color: isActive ? theme.accent : theme.text,
                          }}
                        >
                          {doc.title}
                        </span>
                        <span className="flex items-center gap-2" style={{ fontSize: 10, color: theme.textDim }}>
                          {doc.created && <span>{formatDate(doc.created)}</span>}
                          {doc.kind && doc.kind !== "task" && (
                            <span
                              style={{
                                padding: "0 4px",
                                borderRadius: 2,
                                background: theme.accentMuted,
                                color: theme.accent,
                                fontSize: 9,
                                textTransform: "uppercase",
                              }}
                            >
                              {doc.kind}
                            </span>
                          )}
                          {doc.priority && (
                            <span
                              style={{
                                padding: "0 4px",
                                borderRadius: 2,
                                background: theme.bgTertiary,
                                color: theme.text,
                                fontSize: 9,
                              }}
                            >
                              {doc.priority}
                            </span>
                          )}
                          {doc.status === "active" && !ready && (
                            <span style={{ color: theme.warning }}>blocked</span>
                          )}
                        </span>
                        {isSelected && doc.tags.length > 0 && (
                          <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                            {doc.tags.slice(0, 4).map((tag) => (
                              <span
                                key={tag}
                                style={{
                                  fontSize: 9,
                                  color: theme.accent,
                                  background: theme.accentMuted,
                                  padding: "1px 5px",
                                  borderRadius: 3,
                                }}
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </span>

                      {/* Right column: status/kaomoji + spawn */}
                      <span className="flex flex-col items-end gap-1 flex-shrink-0">
                        {isActive ? (
                          <span style={{ fontSize: 11, color: theme.accent, lineHeight: 1 }}>
                            {kaomoji}
                          </span>
                        ) : (
                          <span className="text-xs" style={{ color: theme.textDim }}>
                            {doc.status}
                          </span>
                        )}
                        {onSpawnClaude && !isActive && (
                          <button
                            onClick={(e) => handleSpawnClaude(e, doc)}
                            className="text-xs px-1.5 py-0.5 rounded"
                            style={{
                              color: "#7c6af5",
                              background: "rgba(124,106,245,0.15)",
                              fontSize: "10px",
                            }}
                            title="Spawn Claude on this task"
                          >
                            ❯
                          </button>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Drag handle — right edge */}
        <div
          onMouseDown={handleDragStart}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: 5,
            cursor: "ew-resize",
            zIndex: 10,
          }}
          title="Drag to resize"
        />
      </div>

      {/* Right: doc viewer */}
      <div className="flex-1 overflow-hidden">
        {selectedDoc ? (
          <DocViewer
            key={selectedDoc.path}
            doc={selectedDoc}
            docs={docs}
            theme={theme}
            onClose={() => setSelectedDoc(null)}
            onDismiss={async () => {
              const filename =
                selectedDoc.path.replace(/\\/g, "/").split("/").pop() ?? "task.md";
              const sep = orgRoot.includes("\\") ? "\\" : "/";
              const dest = `${orgRoot}${sep}archive${sep}tasks${sep}${filename}`;
              await invoke("move_file", { src: selectedDoc.path, dst: dest });
              setSelectedDoc(null);
            }}
            onOpenUrl={onOpenUrl}
            onNavigate={setSelectedDoc}
            onSpawnSwarm={
              onSpawnClaude && selectedDoc.type === "task"
                ? () => {
                    const agentId =
                      typeof selectedDoc.frontmatter?.agent === "string"
                        ? selectedDoc.frontmatter.agent
                        : undefined;
                    onSpawnClaude(selectedDoc.path, selectedDoc.title, undefined, agentId);
                  }
                : undefined
            }
          />
        ) : (
          <div
            className="h-full flex flex-col items-center justify-center gap-2 text-sm"
            style={{ color: theme.textDim }}
          >
            <span>select a task to view</span>
            <span className="text-xs" style={{ color: theme.textDim }}>
              j/k navigate · s status · p priority · c new · / search
            </span>
            {tasks.length > 0 && onSpawnClaude && (
              <span className="text-xs">
                click <span style={{ color: "#7c6af5" }}>❯</span> on any task to spawn an agent
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
