import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ViewProps } from "../components/ViewProps";
import { Theme } from "../themes";
import FlowEditor from "../components/FlowEditor";

interface Step {
  id: string;
  when?: string;
  on_failure?: "abort" | "continue" | "retry";
  retries?: number;
  backoff_ms?: number;
  timeout_secs?: number;
  // flattened kind fields:
  run?: string;
  shell?: string;
  agent?: string;
  model?: string;
  skills?: string[];
  write?: string;
  content?: string;
  read?: string;
  if?: string;
  then?: Step[];
  else?: Step[];
}

interface Routine {
  name: string;
  status: "enabled" | "disabled";
  cron?: string;
  timezone?: string;
  concurrency: "skip" | "queue" | "parallel";
  catchup?: boolean;
  tags?: string[];
  steps: Step[];
  description?: string;
  path?: string;
}

interface RunRecord {
  id: string;
  routine: string;
  started: string;
  finished?: string;
  status: "running" | "ok" | "failed";
  steps: Array<{ id: string; status: string; duration_ms: number; attempts: number; error?: string }>;
  error?: string;
}

const SKELETON = `---
type: routine
status: disabled
cron: "0 9 * * *"
timezone: America/Chicago
concurrency: skip
created: ${new Date().toISOString().slice(0,10)}
tags: []
steps: []
---

# New routine

Describe what this routine does.
`;

export default function RoutinesView({ theme }: ViewProps) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [content, setContent] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const list = await invoke<Routine[]>("list_routines");
      setRoutines(list);
    } catch (e: any) {
      setToast(`Load failed: ${e}`);
    }
  }, []);

  const loadRuns = useCallback(async (name?: string) => {
    try {
      const r = await invoke<RunRecord[]>("list_runs", { name: name ?? null, limit: 25 });
      setRuns(r);
    } catch {}
  }, []);

  // Poll runs every 2s while any run is in "running" state so the UI reflects
  // in-flight progress without manual refresh.
  useEffect(() => {
    const anyRunning = runs.some(r => r.status === "running");
    if (!anyRunning) return;
    const id = setInterval(() => loadRuns(selected ?? undefined), 2000);
    return () => clearInterval(id);
  }, [runs, selected, loadRuns]);

  useEffect(() => {
    loadList();
    loadRuns();
    const u = listen("org-changed", () => { loadList(); loadRuns(selected ?? undefined); });
    return () => { u.then(f => f()); };
  }, [loadList, loadRuns, selected]);

  // Periodically refresh runs while a run could be in flight.
  useEffect(() => {
    const id = setInterval(() => loadRuns(selected ?? undefined), 4000);
    return () => clearInterval(id);
  }, [loadRuns, selected]);

  const loadContent = useCallback(async (name: string) => {
    try {
      const sched = routines.find(s => s.name === name);
      const path = sched?.path ?? `${name}`;
      const raw = await invoke<string>("read_file", { path });
      setContent(raw);
      setDirty(false);
    } catch (e: any) {
      setToast(`Open failed: ${e}`);
    }
  }, [routines]);

  const select = useCallback((name: string) => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    setSelected(name);
    loadContent(name);
    loadRuns(name);
  }, [dirty, loadContent, loadRuns]);

  const create = useCallback(async () => {
    const name = prompt("New routine name (alphanumeric / dash / underscore):");
    if (!name) return;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) { setToast("Invalid name"); return; }
    try {
      await invoke("create_routine", { name, content: SKELETON });
      await loadList();
      setSelected(name);
      setContent(SKELETON);
      setDirty(false);
    } catch (e: any) {
      setToast(`Create failed: ${e}`);
    }
  }, [loadList]);

  const save = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await invoke("update_routine", { name: selected, content });
      setDirty(false);
      setToast("Saved");
      await loadList();
    } catch (e: any) {
      setToast(`Save failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [selected, content, loadList]);

  const remove = useCallback(async () => {
    if (!selected) return;
    if (!confirm(`Delete routine "${selected}"?`)) return;
    try {
      await invoke("delete_routine", { name: selected });
      setSelected(null);
      setContent("");
      await loadList();
    } catch (e: any) {
      setToast(`Delete failed: ${e}`);
    }
  }, [selected, loadList]);

  const runNow = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await invoke("trigger_routine", { name: selected });
      setToast("Triggered");
      setTimeout(() => loadRuns(selected), 600);
    } catch (e: any) {
      setToast(`Trigger failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [selected, loadRuns]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(id);
  }, [toast]);

  // Autosave on Ctrl+S inside the editor textarea is handled by onKeyDown.

  return (
    <div className="flex flex-1 overflow-hidden" style={{ background: theme.bg, color: theme.text }}>
      {/* List pane */}
      <div className="flex flex-col" style={{ width: 280, borderRight: `1px solid ${theme.border}`, background: theme.bgSecondary }}>
        <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: `1px solid ${theme.border}` }}>
          <span style={{ fontWeight: 600 }}>Routines</span>
          <button
            onClick={create}
            className="px-2 py-1 text-xs"
            style={{ background: theme.accentMuted, color: theme.text, borderRadius: 4 }}
            title="New routine"
          >+ New</button>
        </div>
        <div className="flex-1 overflow-auto">
          {routines.length === 0 && (
            <div className="px-3 py-3 text-xs" style={{ color: theme.textMuted }}>
              No routines yet. Click "+ New" to start.
            </div>
          )}
          {routines.map(s => (
            <button
              key={s.name}
              onClick={() => select(s.name)}
              className="w-full text-left px-3 py-2 text-sm flex flex-col gap-0.5"
              style={{
                background: selected === s.name ? theme.bgTertiary : "transparent",
                borderBottom: `1px solid ${theme.border}`,
              }}
            >
              <div className="flex items-center justify-between">
                <span style={{ color: theme.text }}>{s.name}</span>
                <StatusDot status={s.status} theme={theme} />
              </div>
              <div className="flex items-center gap-2 text-xs" style={{ color: theme.textMuted }}>
                <span>{s.cron ?? "no cron"}</span>
                <span>•</span>
                <span>{s.steps?.length ?? 0} steps</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Editor pane */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {selected ? (
          <Editor
            theme={theme}
            name={selected}
            content={content}
            setContent={(c) => { setContent(c); setDirty(true); }}
            dirty={dirty}
            busy={busy}
            onSave={save}
            onDelete={remove}
            onRun={runNow}
            runs={runs.filter(r => r.routine === selected)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center flex-1" style={{ color: theme.textMuted }}>
            <div>Select a routine on the left, or create a new one.</div>
          </div>
        )}
      </div>

      {toast && (
        <div className="absolute bottom-4 right-4 px-3 py-2 text-sm shadow-lg"
          style={{ background: theme.bgTertiary, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 6 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status, theme }: { status: "enabled" | "disabled"; theme: Theme }) {
  const color = status === "enabled" ? theme.success : theme.textDim;
  return <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: color }} title={status} />;
}

interface EditorProps {
  theme: Theme;
  name: string;
  content: string;
  setContent: (c: string) => void;
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
  onDelete: () => void;
  onRun: () => void;
  runs: RunRecord[];
}

function Editor({ theme, name, content, setContent, dirty, busy, onSave, onDelete, onRun, runs }: EditorProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [picker, setPicker] = useState<null | { kind: "file" | "skill"; query: string; from: number }>(null);
  const [tab, setTab] = useState<"flow" | "yaml">("flow");
  // Expanded run shows per-step output (stdout, agent text, error). Loaded
  // on demand from get_run because the list endpoint omits step outputs.
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [expandedRunData, setExpandedRunData] = useState<any | null>(null);
  useEffect(() => {
    if (!expandedRunId) { setExpandedRunData(null); return; }
    let cancelled = false;
    invoke<any>("get_run", { id: expandedRunId })
      .then(data => { if (!cancelled) setExpandedRunData(data); })
      .catch(() => { if (!cancelled) setExpandedRunData(null); });
    return () => { cancelled = true; };
  }, [expandedRunId]);
  // Re-fetch the expanded run while it's still running so live step outputs appear.
  useEffect(() => {
    if (!expandedRunId) return;
    const cur = runs.find(r => r.id === expandedRunId);
    if (cur?.status !== "running") return;
    const id = setInterval(() => {
      invoke<any>("get_run", { id: expandedRunId })
        .then(setExpandedRunData)
        .catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [expandedRunId, runs]);

  const insertAtCursor = useCallback((text: string, replaceFrom?: number) => {
    const ta = taRef.current; if (!ta) return;
    const start = replaceFrom ?? ta.selectionStart;
    const end = ta.selectionEnd;
    const next = content.slice(0, start) + text + content.slice(end);
    setContent(next);
    requestAnimationFrame(() => {
      if (!taRef.current) return;
      const pos = start + text.length;
      taRef.current.focus();
      taRef.current.setSelectionRange(pos, pos);
    });
  }, [content, setContent]);

  // Autocomplete trigger: typing `@` opens file picker, `/` opens skill picker.
  const onKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave();
      return;
    }
    if (picker) {
      // Close picker on Escape.
      if (e.key === "Escape") { e.preventDefault(); setPicker(null); }
      return;
    }
    if (e.key === "@") {
      const ta = e.currentTarget;
      // Defer until char is in the value.
      requestAnimationFrame(() => setPicker({ kind: "file", query: "", from: ta.selectionStart }));
    } else if (e.key === "/") {
      const ta = e.currentTarget;
      requestAnimationFrame(() => setPicker({ kind: "skill", query: "", from: ta.selectionStart }));
    }
  }, [picker, onSave]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    if (picker) {
      const cursor = e.target.selectionStart;
      const trigger = picker.from - 1; // index of @ or /
      if (cursor < trigger || cursor > trigger + 200) { setPicker(null); return; }
      const query = e.target.value.slice(picker.from, cursor);
      // Cancel if user typed whitespace or newline — they moved on.
      if (/\s/.test(query)) { setPicker(null); return; }
      setPicker(p => p && ({ ...p, query }));
    }
  }, [setContent, picker]);

  const lastRun = runs[0];

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${theme.border}`, background: theme.bgSecondary }}>
        <span style={{ fontWeight: 600 }}>{name}.md</span>
        {dirty && <span className="text-xs" style={{ color: theme.warning }}>● unsaved</span>}
        <div className="flex items-center gap-0 ml-3" style={{ border: `1px solid ${theme.border}`, borderRadius: 4, overflow: "hidden" }}>
          <button onClick={() => setTab("flow")} className="px-2 py-1 text-xs"
            style={{ background: tab === "flow" ? theme.accentMuted : "transparent", color: theme.text }}>Flow</button>
          <button onClick={() => setTab("yaml")} className="px-2 py-1 text-xs"
            style={{ background: tab === "yaml" ? theme.accentMuted : "transparent", color: theme.text }}>YAML</button>
        </div>
        <div className="flex-1" />
        {tab === "yaml" && <>
          <ToolbarButton theme={theme} onClick={() => setPicker({ kind: "file", query: "", from: taRef.current?.selectionStart ?? 0 })} title="Insert file reference (@)">@ file</ToolbarButton>
          <ToolbarButton theme={theme} onClick={() => setPicker({ kind: "skill", query: "", from: taRef.current?.selectionStart ?? 0 })} title="Insert skill reference (/)">/ skill</ToolbarButton>
          <ToolbarButton theme={theme} onClick={() => insertAtCursor(STEP_RUN_TEMPLATE)} title="Insert run-step template">+ run</ToolbarButton>
          <ToolbarButton theme={theme} onClick={() => insertAtCursor(STEP_AGENT_TEMPLATE)} title="Insert agent-step template">+ agent</ToolbarButton>
          <ToolbarButton theme={theme} onClick={() => insertAtCursor(STEP_WRITE_TEMPLATE)} title="Insert write-step template">+ write</ToolbarButton>
          <div style={{ width: 8 }} />
        </>}
        <ToolbarButton theme={theme} onClick={onRun} disabled={busy || dirty} title={dirty ? "Save first" : "Trigger now"}>▶ run now</ToolbarButton>
        <ToolbarButton theme={theme} onClick={onSave} disabled={busy || !dirty} title="Save (Ctrl+S)">save</ToolbarButton>
        <ToolbarButton theme={theme} onClick={onDelete} title="Delete routine" style={{ color: theme.error }}>delete</ToolbarButton>
      </div>

      {/* Body: split editor + runs panel */}
      <div className="flex flex-1 overflow-hidden">
        {tab === "flow" ? (
          <FlowEditor theme={theme} content={content} onChange={setContent} />
        ) : (
        <div className="flex-1 relative" style={{ background: theme.bg }}>
          <textarea
            ref={taRef}
            value={content}
            onChange={onChange}
            onKeyDown={onKey}
            spellCheck={false}
            style={{
              width: "100%", height: "100%",
              padding: "12px",
              background: "transparent",
              color: theme.text,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 13,
              lineHeight: 1.55,
              outline: "none",
              resize: "none",
              border: "none",
            }}
          />
          {picker && (
            <ReferencePicker
              theme={theme}
              kind={picker.kind}
              query={picker.query}
              onPick={(value) => {
                if (!picker) return;
                const ta = taRef.current!;
                const cursor = ta.selectionStart;
                const before = content.slice(0, picker.from);
                const after = content.slice(cursor);
                const next = before + value + after;
                setContent(next);
                setPicker(null);
                requestAnimationFrame(() => {
                  if (!taRef.current) return;
                  const pos = (before + value).length;
                  taRef.current.focus();
                  taRef.current.setSelectionRange(pos, pos);
                });
              }}
              onCancel={() => setPicker(null)}
            />
          )}
        </div>
        )}

        {/* Runs side panel */}
        <div style={{ width: 320, borderLeft: `1px solid ${theme.border}`, background: theme.bgSecondary, overflow: "auto" }}>
          <div className="px-3 py-2 text-xs uppercase tracking-wider" style={{ color: theme.textMuted, borderBottom: `1px solid ${theme.border}` }}>
            Recent runs
          </div>
          {runs.length === 0 && (
            <div className="px-3 py-3 text-xs" style={{ color: theme.textMuted }}>No runs yet.</div>
          )}
          {runs.map(r => {
            const isExpanded = expandedRunId === r.id;
            const stepOutputs = isExpanded && expandedRunData?.context?.steps;
            return (
              <div key={r.id} className="px-3 py-2 text-xs" style={{ borderBottom: `1px solid ${theme.border}` }}>
                <div
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => setExpandedRunId(isExpanded ? null : r.id)}
                >
                  <span style={{ color: r.status === "ok" ? theme.success : r.status === "failed" ? theme.error : theme.warning }}>
                    {r.status === "running" ? "● running" : r.status}
                  </span>
                  <span style={{ color: theme.textMuted }}>{shortTime(r.started)}</span>
                </div>
                <div style={{ color: theme.textMuted, fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{r.id}</div>
                {r.error && <div style={{ color: theme.error, marginTop: 2 }}>{r.error}</div>}
                <div className="mt-1 flex gap-1 flex-wrap">
                  {r.steps.map(s => (
                    <span key={s.id} title={`${s.id}: ${s.status} (${s.duration_ms}ms)`}
                      onClick={() => setExpandedRunId(r.id)}
                      style={{
                        fontSize: 10, padding: "1px 6px", borderRadius: 3,
                        cursor: "pointer",
                        background: s.status === "ok" ? theme.accentMuted : s.status === "failed" ? theme.error : theme.bgTertiary,
                        color: theme.text,
                      }}>
                      {s.id}
                    </span>
                  ))}
                </div>
                {isExpanded && stepOutputs && (
                  <div className="mt-2 space-y-2" style={{ borderTop: `1px dashed ${theme.border}`, paddingTop: 6 }}>
                    {r.steps.map(s => {
                      const out = stepOutputs[s.id];
                      if (!out) return null;
                      // Prefer stdout (shell) > output (agent) > full json blob.
                      const text = typeof out.stdout === "string" && out.stdout.trim()
                        ? out.stdout
                        : typeof out.output === "string" && out.output.trim()
                          ? out.output
                          : JSON.stringify(out, null, 2);
                      return (
                        <div key={s.id}>
                          <div style={{ color: theme.textMuted, fontSize: 10, marginBottom: 2 }}>
                            {s.id} <span style={{ opacity: 0.6 }}>· {s.duration_ms}ms · {s.status}</span>
                          </div>
                          {s.error && (
                            <pre style={{
                              whiteSpace: "pre-wrap", color: theme.error,
                              fontSize: 11, margin: 0, padding: "4px 6px",
                              background: theme.bg, borderRadius: 3,
                            }}>{s.error}</pre>
                          )}
                          <pre style={{
                            whiteSpace: "pre-wrap", wordBreak: "break-word",
                            fontSize: 11, margin: 0, padding: "4px 6px",
                            background: theme.bg, borderRadius: 3,
                            maxHeight: 220, overflow: "auto",
                            color: theme.text,
                          }}>{text}</pre>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {lastRun && (
            <div className="px-3 py-2 text-xs" style={{ color: theme.textMuted }}>
              Tail: <span style={{ fontFamily: "monospace" }}>routines/runs/{lastRun.id}.json</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolbarButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { theme: Theme }) {
  const { theme, style, ...rest } = props;
  return (
    <button
      {...rest}
      className="px-2 py-1 text-xs"
      style={{
        background: theme.bgTertiary,
        color: theme.text,
        border: `1px solid ${theme.border}`,
        borderRadius: 4,
        opacity: rest.disabled ? 0.5 : 1,
        cursor: rest.disabled ? "not-allowed" : "pointer",
        ...style,
      }}
    />
  );
}

interface PickerProps {
  theme: Theme;
  kind: "file" | "skill";
  query: string;
  onPick: (value: string) => void;
  onCancel: () => void;
}

function ReferencePicker({ theme, kind, query, onPick, onCancel }: PickerProps) {
  const [items, setItems] = useState<Array<{ name: string; description?: string; path?: string }>>([]);
  const [hi, setHi] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (kind === "file") {
        try {
          const docs = await invoke<Array<{ path: string; title?: string }>>("get_documents");
          if (cancelled) return;
          setItems(docs.slice(0, 500).map(d => ({ name: d.path, description: d.title })));
        } catch { /* keep empty */ }
      } else {
        try {
          const skills = await invoke<Array<{ name: string; description?: string }>>("list_skills");
          if (cancelled) return;
          setItems(skills);
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [kind]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return items.slice(0, 30);
    return items
      .filter(i => i.name.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q))
      .slice(0, 30);
  }, [items, query]);

  useEffect(() => { setHi(0); }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setHi(h => Math.min(filtered.length - 1, h + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
      else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const it = filtered[hi]; if (!it) return;
        const value = kind === "file" ? `${it.name}` : `${it.name}`;
        onPick(value);
      } else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filtered, hi, kind, onPick, onCancel]);

  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        bottom: 12,
        width: 420,
        maxHeight: 360,
        overflow: "auto",
        background: theme.bgSecondary,
        border: `1px solid ${theme.accent}`,
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,.4)",
        zIndex: 50,
      }}
    >
      <div className="px-3 py-2 text-xs flex items-center justify-between" style={{ borderBottom: `1px solid ${theme.border}`, color: theme.textMuted }}>
        <span>{kind === "file" ? "Insert file reference" : "Insert skill reference"} — type to filter, Enter to insert, Esc to cancel</span>
        <span style={{ color: theme.textDim }}>{filtered.length}</span>
      </div>
      {filtered.length === 0 && (
        <div className="px-3 py-3 text-xs" style={{ color: theme.textMuted }}>No matches.</div>
      )}
      {filtered.map((it, i) => (
        <div
          key={it.name}
          className="px-3 py-1.5 text-xs cursor-pointer"
          style={{
            background: i === hi ? theme.bgTertiary : "transparent",
            borderBottom: `1px solid ${theme.border}`,
          }}
          onMouseEnter={() => setHi(i)}
          onClick={() => onPick(it.name)}
        >
          <div style={{ fontFamily: "ui-monospace, monospace" }}>
            {kind === "file" ? it.name : `/${it.name}`}
          </div>
          {it.description && <div style={{ color: theme.textMuted, marginTop: 1 }}>{it.description}</div>}
        </div>
      ))}
    </div>
  );
}

function shortTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

const STEP_RUN_TEMPLATE = `
  - id: new_run_step
    run: "echo hello"
    on_failure: abort
`;
const STEP_AGENT_TEMPLATE = `
  - id: new_agent_step
    agent: |
      Replace this with your prompt. Reference files with @path and skills with /name.
    model: claude-sonnet-4-6
    on_failure: continue
`;
const STEP_WRITE_TEMPLATE = `
  - id: new_write_step
    write: "context/note-{{ run.date }}.md"
    content: "Generated at {{ run.started }}"
`;
