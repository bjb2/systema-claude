import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  Handle, Position, NodeProps, EdgeProps,
  applyNodeChanges, applyEdgeChanges, addEdge,
  Node, Edge, Connection, NodeChange, EdgeChange,
  getBezierPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { invoke } from "@tauri-apps/api/core";
import { Theme } from "../themes";
import {
  Step, StepKind, FlowNode, FlowEdge,
  parseRoutine, serializeRoutine, stepKind, setStepKind, newStepId,
  toGraph, fromGraph,
} from "../lib/routineSerialize";

interface Props {
  theme: Theme;
  content: string;
  onChange: (next: string) => void;
}

const KIND_COLORS: Record<StepKind, string> = {
  run:   "#7c6af5",
  agent: "#4af076",
  write: "#f0c44a",
  read:  "#4ac8f0",
  if:    "#f07a4a",
};

export default function FlowEditor({ theme, content, onChange }: Props) {
  const parsed = useMemo(() => parseRoutine(content), [content]);
  const initial = useMemo(() => toGraph(parsed.frontmatter.steps ?? []), [parsed.frontmatter.steps]);

  const [nodes, setNodes] = useState<Node[]>(() => toRfNodes(initial.nodes, theme));
  const [edges, setEdges] = useState<Edge[]>(() => toRfEdges(initial.edges, theme));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stepsRef = useRef<Step[]>(parsed.frontmatter.steps ?? []);

  // Reset state when external content changes (e.g. new routine selected).
  useEffect(() => {
    const p = parseRoutine(content);
    const g = toGraph(p.frontmatter.steps ?? []);
    stepsRef.current = p.frontmatter.steps ?? [];
    setNodes(toRfNodes(g.nodes, theme));
    setEdges(toRfEdges(g.edges, theme));
  }, [content, theme]);

  const flush = useCallback((nextSteps: Step[]) => {
    const p = parseRoutine(content);
    p.frontmatter.steps = nextSteps;
    onChange(serializeRoutine(p));
  }, [content, onChange]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(ns => {
      const next = applyNodeChanges(changes, ns);
      // Persist position changes to steps when drag finishes.
      const positionDone = changes.some(c => c.type === "position" && (c as any).dragging === false);
      if (positionDone) {
        const flowNodes: FlowNode[] = next.map(n => ({
          id: n.id,
          kind: (n.data as any).kind,
          position: { x: n.position.x, y: n.position.y },
          data: (n.data as any).step as Step,
        }));
        const flowEdges: FlowEdge[] = edges.map(e => ({
          id: e.id, source: e.source, target: e.target,
          sourceHandle: (e.sourceHandle as any) ?? "success",
        }));
        const updated = fromGraph(stepsRef.current.slice(), flowNodes, flowEdges);
        stepsRef.current = updated;
        flush(updated);
      }
      return next;
    });
  }, [edges, flush]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(es => {
      const next = applyEdgeChanges(changes, es);
      const flowEdges: FlowEdge[] = next.map(e => ({
        id: e.id, source: e.source, target: e.target,
        sourceHandle: (e.sourceHandle as any) ?? "success",
      }));
      const flowNodes: FlowNode[] = nodes.map(n => ({
        id: n.id, kind: (n.data as any).kind,
        position: { x: n.position.x, y: n.position.y },
        data: (n.data as any).step as Step,
      }));
      const updated = fromGraph(stepsRef.current.slice(), flowNodes, flowEdges);
      stepsRef.current = updated;
      flush(updated);
      return next;
    });
  }, [nodes, flush]);

  const onConnect = useCallback((conn: Connection) => {
    setEdges(es => {
      const id = `${conn.source}-${conn.sourceHandle ?? "success"}->${conn.target}`;
      // For "success" handle: allow multiple outgoing. For "failure": replace.
      const cleared = conn.sourceHandle === "failure"
        ? es.filter(e => !(e.source === conn.source && e.sourceHandle === "failure"))
        : es;
      const next = addEdge({ ...conn, id, type: "labeled", data: { sourceHandle: conn.sourceHandle } }, cleared);
      const flowEdges: FlowEdge[] = next.map(e => ({
        id: e.id, source: e.source, target: e.target,
        sourceHandle: (e.sourceHandle as any) ?? "success",
      }));
      const flowNodes: FlowNode[] = nodes.map(n => ({
        id: n.id, kind: (n.data as any).kind,
        position: { x: n.position.x, y: n.position.y },
        data: (n.data as any).step as Step,
      }));
      const updated = fromGraph(stepsRef.current.slice(), flowNodes, flowEdges);
      stepsRef.current = updated;
      flush(updated);
      return next;
    });
  }, [nodes, flush]);

  const addNode = useCallback((kind: StepKind) => {
    const id = newStepId(stepsRef.current, kind);
    const step: Step = setStepKind({ id }, kind);
    step.position = { x: 200 + Math.random() * 200, y: 80 + stepsRef.current.length * 30 };
    const nextSteps = [...stepsRef.current, step];
    stepsRef.current = nextSteps;
    setNodes(ns => [...ns, makeRfNode(step, theme)]);
    setSelectedId(id);
    flush(nextSteps);
  }, [theme, flush]);

  const updateStep = useCallback((id: string, patch: Partial<Step>) => {
    const nextSteps = stepsRef.current.map(s => s.id === id ? { ...s, ...patch } : s);
    stepsRef.current = nextSteps;
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, step: nextSteps.find(s => s.id === id) } } : n));
    flush(nextSteps);
  }, [flush]);

  const renameStep = useCallback((id: string, newId: string) => {
    if (!newId || newId === id) return;
    if (stepsRef.current.some(s => s.id === newId)) return;
    const nextSteps = stepsRef.current.map(s => s.id === id ? { ...s, id: newId } : ({
      ...s,
      next: s.next?.map(n => n === id ? newId : n),
      next_on_failure: s.next_on_failure === id ? newId : s.next_on_failure,
    }));
    stepsRef.current = nextSteps;
    setNodes(ns => ns.map(n => n.id === id ? { ...n, id: newId, data: { ...n.data, step: nextSteps.find(s => s.id === newId) } } : n));
    setEdges(es => es.map(e => ({
      ...e,
      source: e.source === id ? newId : e.source,
      target: e.target === id ? newId : e.target,
      id: e.id.replace(id, newId),
    })));
    setSelectedId(newId);
    flush(nextSteps);
  }, [flush]);

  const deleteStep = useCallback((id: string) => {
    const nextSteps = stepsRef.current
      .filter(s => s.id !== id)
      .map(s => ({
        ...s,
        next: s.next?.filter(n => n !== id),
        next_on_failure: s.next_on_failure === id ? undefined : s.next_on_failure,
      }));
    stepsRef.current = nextSteps;
    setNodes(ns => ns.filter(n => n.id !== id));
    setEdges(es => es.filter(e => e.source !== id && e.target !== id));
    setSelectedId(null);
    flush(nextSteps);
  }, [flush]);

  const selected = stepsRef.current.find(s => s.id === selectedId) ?? null;

  // Routine-level frontmatter editor.
  const updateFrontmatter = useCallback((patch: Partial<typeof parsed.frontmatter>) => {
    const p = parseRoutine(content);
    p.frontmatter = { ...p.frontmatter, ...patch };
    onChange(serializeRoutine(p));
  }, [content, onChange]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden" style={{ background: theme.bg }}>
      <ScheduleHeader theme={theme} frontmatter={parsed.frontmatter} onChange={updateFrontmatter} />
      <div className="flex flex-1 overflow-hidden">
      <div className="flex-1 relative">
        {/* Add-node toolbar */}
        <div className="absolute top-2 left-2 flex gap-1 z-10">
          {(["run", "agent", "write", "read", "if"] as StepKind[]).map(k => (
            <button key={k} onClick={() => addNode(k)}
              className="px-2 py-1 text-xs"
              style={{ background: theme.bgSecondary, border: `1px solid ${KIND_COLORS[k]}`, color: theme.text, borderRadius: 4 }}
              title={`Add ${k} node`}
            >+ {k}</button>
          ))}
        </div>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_e, n) => setSelectedId(n.id)}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            fitView
            proOptions={{ hideAttribution: true }}
            style={{ background: theme.bg }}
          >
            <Background color={theme.border} gap={20} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={n => KIND_COLORS[(n.data as any).kind as StepKind] ?? theme.accent} style={{ background: theme.bgSecondary }} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>

      {/* Node inspector */}
      <div style={{ width: 360, borderLeft: `1px solid ${theme.border}`, background: theme.bgSecondary, overflow: "auto" }}>
        {selected ? (
          <NodeInspector
            theme={theme}
            step={selected}
            onChange={(patch) => updateStep(selected.id, patch)}
            onRename={(newId) => renameStep(selected.id, newId)}
            onDelete={() => deleteStep(selected.id)}
            onChangeKind={(kind) => updateStep(selected.id, setStepKind(selected, kind))}
          />
        ) : (
          <div className="p-3 text-xs" style={{ color: theme.textMuted }}>
            Select a node to edit. Connect output handles to define `next` (success) or `next_on_failure` (red).
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

/* ============================== Routine header ============================== */

interface ScheduleHeaderProps {
  theme: Theme;
  frontmatter: any;
  onChange: (patch: any) => void;
}

function ScheduleHeader({ theme, frontmatter, onChange }: ScheduleHeaderProps) {
  const status = frontmatter.status ?? "disabled";
  const cron = frontmatter.cron ?? "";
  const tz = frontmatter.timezone ?? "";
  const conc = frontmatter.concurrency ?? "skip";
  const tags: string[] = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  const [tagDraft, setTagDraft] = useState("");

  return (
    <div className="flex items-center gap-3 px-3 py-2 flex-wrap" style={{ borderBottom: `1px solid ${theme.border}`, background: theme.bgTertiary }}>
      <label className="flex items-center gap-1 text-xs" style={{ color: theme.text }}>
        <span style={{ color: theme.textMuted }}>status</span>
        <button
          onClick={() => onChange({ status: status === "enabled" ? "disabled" : "enabled" })}
          className="px-2 py-0.5"
          style={{
            background: status === "enabled" ? theme.success : theme.bgSecondary,
            color: status === "enabled" ? "#000" : theme.text,
            border: `1px solid ${status === "enabled" ? theme.success : theme.border}`,
            borderRadius: 4,
            fontWeight: 600,
            minWidth: 70,
          }}
          title="Toggle enabled/disabled"
        >
          {status}
        </button>
      </label>

      <CronBuilder theme={theme} value={cron} onChange={(v) => onChange({ cron: v })} />

      <label className="flex items-center gap-1 text-xs" style={{ color: theme.text }}>
        <span style={{ color: theme.textMuted }}>tz</span>
        <select
          value={tz || "America/Chicago"}
          onChange={e => onChange({ timezone: e.target.value })}
          style={{ ...headerInput(theme), width: 160 }}
        >
          {COMMON_TZ.map(z => <option key={z} value={z}>{z}</option>)}
        </select>
      </label>

      <label className="flex items-center gap-1 text-xs" style={{ color: theme.text }}>
        <span style={{ color: theme.textMuted }}>concurrency</span>
        <select
          value={conc}
          onChange={e => onChange({ concurrency: e.target.value })}
          style={headerInput(theme)}
          title="skip = ignore overlapping fires; queue = wait in line; parallel = run anyway"
        >
          <option value="skip">skip</option>
          <option value="queue">queue</option>
          <option value="parallel">parallel</option>
        </select>
      </label>

      <div className="flex items-center gap-1 text-xs flex-wrap" style={{ color: theme.text }}>
        <span style={{ color: theme.textMuted }}>tags</span>
        {tags.map(t => (
          <span key={t}
            className="px-1.5 py-0.5 cursor-pointer"
            style={{ background: theme.accentMuted, color: theme.text, borderRadius: 3 }}
            onClick={() => onChange({ tags: tags.filter(x => x !== t) })}
            title="Click to remove"
          >{t} ✕</span>
        ))}
        <input
          value={tagDraft}
          onChange={e => setTagDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && tagDraft.trim()) {
              e.preventDefault();
              const t = tagDraft.trim();
              if (!tags.includes(t)) onChange({ tags: [...tags, t] });
              setTagDraft("");
            }
          }}
          placeholder="+tag"
          style={{ ...headerInput(theme), width: 80 }}
        />
      </div>
    </div>
  );
}

const COMMON_TZ = [
  "America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "UTC",
  "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney",
];

/* ============================== Cron Builder ============================== */

type CronMode = "minutes" | "hourly" | "daily" | "weekly" | "weekdays" | "monthly" | "custom";

interface CronModel {
  mode: CronMode;
  interval: number;       // for "minutes": every N min
  hour: number;           // 0-23
  minute: number;         // 0-59
  days: string[];         // for weekly: ["MON", "WED"]
  dayOfMonth: number;     // for monthly: 1-31
}

const DAY_OPTS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function CronBuilder({ theme, value, onChange }: { theme: Theme; value: string; onChange: (cron: string) => void }) {
  const model = useMemo(() => parseCron(value), [value]);
  const update = (patch: Partial<CronModel>) => {
    const next = { ...model, ...patch };
    onChange(buildCron(next));
  };
  const [showCustom, setShowCustom] = useState(model.mode === "custom");
  useEffect(() => { if (model.mode === "custom") setShowCustom(true); }, [model.mode]);

  return (
    <div className="flex items-center gap-1 text-xs" style={{ color: theme.text }}>
      <span style={{ color: theme.textMuted }}>when</span>
      <select
        value={model.mode}
        onChange={e => update({ mode: e.target.value as CronMode })}
        style={headerInput(theme)}
      >
        <option value="minutes">every N min</option>
        <option value="hourly">hourly</option>
        <option value="daily">daily</option>
        <option value="weekdays">weekdays</option>
        <option value="weekly">weekly</option>
        <option value="monthly">monthly</option>
        <option value="custom">custom cron</option>
      </select>

      {model.mode === "minutes" && (
        <>
          <input type="number" min={1} max={59} value={model.interval}
            onChange={e => update({ interval: clamp(parseInt(e.target.value) || 1, 1, 59) })}
            style={{ ...headerInput(theme), width: 50 }} />
          <span style={{ color: theme.textMuted }}>min</span>
        </>
      )}

      {model.mode === "hourly" && (
        <>
          <span style={{ color: theme.textMuted }}>at :</span>
          <input type="number" min={0} max={59} value={model.minute}
            onChange={e => update({ minute: clamp(parseInt(e.target.value) || 0, 0, 59) })}
            style={{ ...headerInput(theme), width: 50 }} />
        </>
      )}

      {(model.mode === "daily" || model.mode === "weekdays") && (
        <TimePicker theme={theme} hour={model.hour} minute={model.minute}
          onChange={(h, m) => update({ hour: h, minute: m })} />
      )}

      {model.mode === "weekly" && (
        <>
          <DayPicker theme={theme} value={model.days} onChange={(days) => update({ days })} />
          <TimePicker theme={theme} hour={model.hour} minute={model.minute}
            onChange={(h, m) => update({ hour: h, minute: m })} />
        </>
      )}

      {model.mode === "monthly" && (
        <>
          <span style={{ color: theme.textMuted }}>day</span>
          <input type="number" min={1} max={31} value={model.dayOfMonth}
            onChange={e => update({ dayOfMonth: clamp(parseInt(e.target.value) || 1, 1, 31) })}
            style={{ ...headerInput(theme), width: 50 }} />
          <TimePicker theme={theme} hour={model.hour} minute={model.minute}
            onChange={(h, m) => update({ hour: h, minute: m })} />
        </>
      )}

      {model.mode === "custom" && (
        <input value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="0 9 * * MON"
          style={{ ...headerInput(theme), width: 180 }} />
      )}

      <button
        onClick={() => setShowCustom(s => !s)}
        className="px-1.5 py-0.5 ml-1"
        style={{ ...headerInput(theme), color: theme.textMuted }}
        title="Show / hide raw cron expression"
      >{showCustom ? "▼" : "▶"} cron</button>
      {showCustom && model.mode !== "custom" && (
        <code className="px-1.5 py-0.5" style={{ background: theme.bgSecondary, color: theme.textMuted, borderRadius: 3, fontSize: 11 }}>
          {value || "(none)"}
        </code>
      )}
    </div>
  );
}

function TimePicker({ theme, hour, minute, onChange }: { theme: Theme; hour: number; minute: number; onChange: (h: number, m: number) => void }) {
  const valueStr = `${pad2(hour)}:${pad2(minute)}`;
  return (
    <>
      <span style={{ color: theme.textMuted }}>at</span>
      <input
        type="time"
        value={valueStr}
        onChange={e => {
          const [h, m] = e.target.value.split(":").map(s => parseInt(s) || 0);
          onChange(clamp(h, 0, 23), clamp(m, 0, 59));
        }}
        style={{ ...headerInput(theme), width: 100 }}
      />
    </>
  );
}

function DayPicker({ theme, value, onChange }: { theme: Theme; value: string[]; onChange: (days: string[]) => void }) {
  return (
    <div className="flex gap-0">
      {DAY_OPTS.map(d => {
        const on = value.includes(d);
        return (
          <button key={d}
            onClick={() => onChange(on ? value.filter(x => x !== d) : [...value, d])}
            className="px-1.5 py-0.5"
            style={{
              background: on ? theme.accent : theme.bgSecondary,
              color: on ? "#000" : theme.textMuted,
              border: `1px solid ${theme.border}`,
              fontSize: 10,
              fontWeight: on ? 600 : 400,
              minWidth: 28,
            }}
          >{d.slice(0, 1)}</button>
        );
      })}
    </div>
  );
}

function parseCron(expr: string): CronModel {
  const parts = expr.trim().split(/\s+/);
  const def: CronModel = { mode: "daily", interval: 5, hour: 9, minute: 0, days: ["MON"], dayOfMonth: 1 };
  if (parts.length !== 5) return { ...def, mode: expr ? "custom" : "daily" };
  const [m, h, dom, mon, dow] = parts;

  // every N min
  const minMatch = m.match(/^\*\/(\d+)$/);
  if (minMatch && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { ...def, mode: "minutes", interval: parseInt(minMatch[1]) };
  }
  // hourly
  if (/^\d+$/.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { ...def, mode: "hourly", minute: parseInt(m) };
  }
  // monthly
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && /^\d+$/.test(dom) && mon === "*" && dow === "*") {
    return { ...def, mode: "monthly", minute: parseInt(m), hour: parseInt(h), dayOfMonth: parseInt(dom) };
  }
  // daily / weekdays / weekly
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === "*" && mon === "*") {
    if (dow === "*") return { ...def, mode: "daily", minute: parseInt(m), hour: parseInt(h) };
    if (dow === "MON-FRI" || dow === "1-5") return { ...def, mode: "weekdays", minute: parseInt(m), hour: parseInt(h) };
    const days = dow.split(",").map(d => d.trim().toUpperCase()).filter(d => DAY_OPTS.includes(d));
    if (days.length) return { ...def, mode: "weekly", minute: parseInt(m), hour: parseInt(h), days };
  }
  return { ...def, mode: "custom" };
}

function buildCron(m: CronModel): string {
  switch (m.mode) {
    case "minutes":  return `*/${m.interval} * * * *`;
    case "hourly":   return `${m.minute} * * * *`;
    case "daily":    return `${m.minute} ${m.hour} * * *`;
    case "weekdays": return `${m.minute} ${m.hour} * * MON-FRI`;
    case "weekly":   return `${m.minute} ${m.hour} * * ${m.days.length ? m.days.join(",") : "MON"}`;
    case "monthly":  return `${m.minute} ${m.hour} ${m.dayOfMonth} * *`;
    case "custom":   return ""; // caller manages raw input
  }
}

function pad2(n: number): string { return n.toString().padStart(2, "0"); }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

function headerInput(theme: Theme): React.CSSProperties {
  return {
    padding: "2px 6px",
    background: theme.bg,
    color: theme.text,
    border: `1px solid ${theme.border}`,
    borderRadius: 4,
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
  };
}

/* ============================== Custom node ============================== */

interface StepNodeData { kind: StepKind; step: Step; theme: Theme }

function StepNode({ data }: NodeProps) {
  const { kind, step, theme } = data as unknown as StepNodeData;
  const color = KIND_COLORS[kind];
  const preview =
    kind === "run"   ? truncate(step.run ?? "", 60) :
    kind === "agent" ? truncate(step.agent ?? "", 60) :
    kind === "write" ? truncate(step.write ?? "", 60) :
    kind === "read"  ? truncate(step.read ?? "", 60) :
                       truncate(step.if ?? "", 60);
  return (
    <div style={{
      minWidth: 200, maxWidth: 240,
      background: theme.bgSecondary,
      border: `1px solid ${color}`,
      borderRadius: 6,
      color: theme.text,
      fontSize: 12,
      boxShadow: "0 2px 6px rgba(0,0,0,.25)",
    }}>
      <Handle type="target" position={Position.Top} style={{ background: color }} />
      <div style={{ padding: "6px 10px", borderBottom: `1px solid ${theme.border}`, background: color, color: "#000", fontWeight: 600, borderTopLeftRadius: 6, borderTopRightRadius: 6 }}>
        <span style={{ textTransform: "uppercase", fontSize: 10, letterSpacing: 1 }}>{kind}</span>
        <span style={{ marginLeft: 6, fontWeight: 400 }}>{step.id}</span>
      </div>
      <div style={{ padding: "8px 10px", fontFamily: "ui-monospace, monospace", fontSize: 11, color: theme.textMuted, whiteSpace: "pre-wrap", maxHeight: 80, overflow: "hidden" }}>
        {preview || <span style={{ color: theme.textDim }}>(empty)</span>}
      </div>
      {step.on_failure === "continue" && (
        <Handle type="source" position={Position.Bottom} id="failure" style={{ background: theme.error, left: "30%" }} />
      )}
      <Handle type="source" position={Position.Bottom} id="success" style={{ background: color, left: step.on_failure === "continue" ? "70%" : "50%" }} />
    </div>
  );
}

function LabeledEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, sourceHandleId, style } = props;
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const stroke = sourceHandleId === "failure" ? "#f05a4a" : (style as any)?.stroke ?? "#888";
  return <path d={path} stroke={stroke} strokeWidth={1.5} fill="none" markerEnd="url(#react-flow__arrow)" />;
}

const NODE_TYPES: any = {
  run: StepNode, agent: StepNode, write: StepNode, read: StepNode, if: StepNode,
};

const EDGE_TYPES: any = { labeled: LabeledEdge };

function makeRfNode(step: Step, theme: Theme): Node {
  return {
    id: step.id,
    type: stepKind(step),
    position: step.position ?? { x: 80, y: 80 },
    data: { kind: stepKind(step), step, theme } as any,
  };
}

function toRfNodes(nodes: FlowNode[], theme: Theme): Node[] {
  return nodes.map(n => ({
    id: n.id,
    type: n.kind,
    position: n.position,
    data: { kind: n.kind, step: n.data, theme } as any,
  }));
}

function toRfEdges(edges: FlowEdge[], theme: Theme): Edge[] {
  return edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? "success",
    type: "labeled",
    style: { stroke: e.sourceHandle === "failure" ? theme.error : theme.accent },
  }));
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/* ============================== Inspector ============================== */

interface InspectorProps {
  theme: Theme;
  step: Step;
  onChange: (patch: Partial<Step>) => void;
  onRename: (newId: string) => void;
  onDelete: () => void;
  onChangeKind: (kind: StepKind) => void;
}

function NodeInspector({ theme, step, onChange, onRename, onDelete, onChangeKind }: InspectorProps) {
  const kind = stepKind(step);
  const [idDraft, setIdDraft] = useState(step.id);
  useEffect(() => setIdDraft(step.id), [step.id]);
  return (
    <div className="p-3 flex flex-col gap-3" style={{ color: theme.text }}>
      <div className="flex items-center justify-between">
        <span style={{ fontWeight: 600 }}>Node</span>
        <button onClick={onDelete} className="text-xs" style={{ color: theme.error }}>Delete</button>
      </div>

      <Field theme={theme} label="id">
        <input
          value={idDraft}
          onChange={e => setIdDraft(e.target.value)}
          onBlur={() => onRename(idDraft)}
          style={inputStyle(theme)}
        />
      </Field>

      <Field theme={theme} label="type">
        <select value={kind} onChange={e => onChangeKind(e.target.value as StepKind)} style={inputStyle(theme)}>
          {(["run", "agent", "write", "read", "if"] as StepKind[]).map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      </Field>

      {kind === "run" && (
        <PromptField theme={theme} label="run (shell command)" value={step.run ?? ""} onChange={v => onChange({ run: v })} />
      )}
      {kind === "agent" && (
        <>
          <PromptField theme={theme} label="agent prompt" value={step.agent ?? ""} onChange={v => onChange({ agent: v })} multiline />
          <Field theme={theme} label="model">
            <input value={step.model ?? ""} onChange={e => onChange({ model: e.target.value })} placeholder="claude-sonnet-4-6" style={inputStyle(theme)} />
          </Field>
          <SkillsPicker theme={theme} value={step.skills ?? []} onChange={v => onChange({ skills: v })} />
        </>
      )}
      {kind === "write" && (
        <>
          <PromptField theme={theme} label="write (path)" value={step.write ?? ""} onChange={v => onChange({ write: v })} />
          <PromptField theme={theme} label="content" value={step.content ?? ""} onChange={v => onChange({ content: v })} multiline />
        </>
      )}
      {kind === "read" && (
        <PromptField theme={theme} label="read (path)" value={step.read ?? ""} onChange={v => onChange({ read: v })} />
      )}
      {kind === "if" && (
        <PromptField theme={theme} label="if (expression)" value={step.if ?? ""} onChange={v => onChange({ if: v })} />
      )}

      <Field theme={theme} label="when (optional gate)">
        <input value={step.when ?? ""} onChange={e => onChange({ when: e.target.value || undefined })} style={inputStyle(theme)} />
      </Field>

      <Field theme={theme} label="on_failure">
        <select value={step.on_failure ?? "abort"} onChange={e => onChange({ on_failure: e.target.value as any })} style={inputStyle(theme)}>
          <option value="abort">abort</option>
          <option value="continue">continue (uses red handle)</option>
          <option value="retry">retry</option>
        </select>
      </Field>

      {step.on_failure === "retry" && (
        <Field theme={theme} label="retries">
          <input type="number" min={1} value={step.retries ?? 1} onChange={e => onChange({ retries: parseInt(e.target.value) || 1 })} style={inputStyle(theme)} />
        </Field>
      )}

      <Field theme={theme} label="timeout (sec)">
        <input type="number" min={1} value={step.timeout_secs ?? 300} onChange={e => onChange({ timeout_secs: parseInt(e.target.value) || 300 })} style={inputStyle(theme)} />
      </Field>
    </div>
  );
}

function Field({ theme, label, children }: { theme: Theme; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs" style={{ color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
      {children}
    </div>
  );
}

function inputStyle(theme: Theme): React.CSSProperties {
  return {
    width: "100%",
    padding: "4px 8px",
    background: theme.bg,
    color: theme.text,
    border: `1px solid ${theme.border}`,
    borderRadius: 4,
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
  };
}

/* ============================== Prompt field with @file / /skill picker ============================== */

interface PromptFieldProps {
  theme: Theme;
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}

function PromptField({ theme, label, value, onChange, multiline }: PromptFieldProps) {
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [picker, setPicker] = useState<null | { kind: "file" | "skill"; query: string; from: number }>(null);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (picker && e.key === "Escape") { e.preventDefault(); setPicker(null); }
  };

  const onLocalChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = e.target.value;
    const cursor = e.target.selectionStart ?? next.length;
    const last = next[cursor - 1];
    onChange(next);
    if (last === "@") setPicker({ kind: "file", query: "", from: cursor });
    else if (last === "/") setPicker({ kind: "skill", query: "", from: cursor });
    else if (picker) {
      if (cursor < picker.from) { setPicker(null); return; }
      const q = next.slice(picker.from, cursor);
      if (/\s/.test(q)) { setPicker(null); return; }
      setPicker(p => p && ({ ...p, query: q }));
    }
  };

  const insert = (replacement: string) => {
    if (!picker) return;
    const el = ref.current!;
    const cursor = el.selectionStart ?? value.length;
    const before = value.slice(0, picker.from);
    const after = value.slice(cursor);
    const next = before + replacement + after;
    onChange(next);
    setPicker(null);
    requestAnimationFrame(() => {
      if (!ref.current) return;
      const pos = (before + replacement).length;
      ref.current.focus();
      (ref.current as any).setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="flex flex-col gap-1 relative">
      <span className="text-xs" style={{ color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
      {multiline ? (
        <textarea ref={ref as any} value={value} onChange={onLocalChange} onKeyDown={onKey}
          rows={6} spellCheck={false} style={{ ...inputStyle(theme), fontFamily: "ui-monospace, monospace", resize: "vertical" }} />
      ) : (
        <input ref={ref as any} value={value} onChange={onLocalChange} onKeyDown={onKey} style={inputStyle(theme)} />
      )}
      <div className="text-xs" style={{ color: theme.textDim }}>Type <kbd>@</kbd> to insert a file, <kbd>/</kbd> for a skill.</div>
      {picker && (
        <PickerPopover theme={theme} kind={picker.kind} query={picker.query} onPick={insert} onCancel={() => setPicker(null)} />
      )}
    </div>
  );
}

function PickerPopover({ theme, kind, query, onPick, onCancel }: { theme: Theme; kind: "file" | "skill"; query: string; onPick: (v: string) => void; onCancel: () => void }) {
  const [items, setItems] = useState<Array<{ name: string; description?: string }>>([]);
  const [hi, setHi] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (kind === "file") {
          const docs = await invoke<Array<{ path: string; title?: string }>>("get_documents");
          if (cancelled) return;
          setItems(docs.slice(0, 500).map(d => ({ name: d.path, description: d.title })));
        } else {
          const skills = await invoke<Array<{ name: string; description?: string }>>("list_skills");
          if (cancelled) return;
          setItems(skills);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [kind]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return items.slice(0, 30);
    return items.filter(i => i.name.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q)).slice(0, 30);
  }, [items, query]);
  useEffect(() => setHi(0), [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setHi(h => Math.min(filtered.length - 1, h + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
      else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const it = filtered[hi]; if (!it) return;
        onPick(it.name);
      } else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filtered, hi, onPick, onCancel]);

  return (
    <div style={{
      position: "absolute", left: 0, top: "100%", zIndex: 50, width: "100%",
      maxHeight: 260, overflow: "auto",
      background: theme.bgSecondary, border: `1px solid ${theme.accent}`, borderRadius: 6,
      boxShadow: "0 8px 24px rgba(0,0,0,.4)",
    }}>
      <div className="px-2 py-1 text-xs" style={{ borderBottom: `1px solid ${theme.border}`, color: theme.textMuted }}>
        {kind === "file" ? "Insert file path" : "Insert skill name"} — Enter to insert, Esc to cancel
      </div>
      {filtered.length === 0 && <div className="px-2 py-2 text-xs" style={{ color: theme.textMuted }}>No matches</div>}
      {filtered.map((it, i) => (
        <div key={it.name}
          onMouseEnter={() => setHi(i)}
          onClick={() => onPick(it.name)}
          className="px-2 py-1 text-xs cursor-pointer"
          style={{ background: i === hi ? theme.bgTertiary : "transparent", borderBottom: `1px solid ${theme.border}`, fontFamily: "ui-monospace, monospace" }}>
          <div>{kind === "skill" ? `/${it.name}` : it.name}</div>
          {it.description && <div style={{ color: theme.textMuted }}>{it.description}</div>}
        </div>
      ))}
    </div>
  );
}

/* ============================== Skills multi-picker ============================== */

function SkillsPicker({ theme, value, onChange }: { theme: Theme; value: string[]; onChange: (v: string[]) => void }) {
  const [available, setAvailable] = useState<Array<{ name: string; description?: string }>>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    invoke<Array<{ name: string; description?: string }>>("list_skills").then(setAvailable).catch(() => {});
  }, []);
  const toggle = (n: string) => {
    if (value.includes(n)) onChange(value.filter(v => v !== n));
    else onChange([...value, n]);
  };
  return (
    <div className="flex flex-col gap-1 relative">
      <span className="text-xs" style={{ color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>skills (preload)</span>
      <div className="flex flex-wrap gap-1">
        {value.length === 0 && <span className="text-xs" style={{ color: theme.textDim }}>none</span>}
        {value.map(n => (
          <span key={n} className="text-xs px-2 py-0.5"
            style={{ background: theme.accentMuted, color: theme.text, borderRadius: 4, cursor: "pointer" }}
            onClick={() => toggle(n)} title="Click to remove">/{n} ✕</span>
        ))}
        <button onClick={() => setOpen(o => !o)} className="text-xs px-2 py-0.5"
          style={{ background: theme.bgTertiary, border: `1px solid ${theme.border}`, color: theme.text, borderRadius: 4 }}>+ skill</button>
      </div>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 40, width: "100%", maxHeight: 220, overflow: "auto",
          background: theme.bgSecondary, border: `1px solid ${theme.accent}`, borderRadius: 6,
        }}>
          {available.map(s => (
            <div key={s.name} className="px-2 py-1 text-xs cursor-pointer"
              style={{ background: value.includes(s.name) ? theme.accentMuted : "transparent", borderBottom: `1px solid ${theme.border}` }}
              onClick={() => toggle(s.name)}>
              <div style={{ fontFamily: "ui-monospace, monospace" }}>/{s.name}</div>
              {s.description && <div style={{ color: theme.textMuted }}>{s.description}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
