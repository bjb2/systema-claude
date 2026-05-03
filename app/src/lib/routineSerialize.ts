import yaml from "js-yaml";

export interface NodePosition { x: number; y: number }

export type StepKind =
  | "run" | "agent" | "write" | "read" | "if";

export interface Step {
  id: string;
  // step kind fields (flattened):
  run?: string; shell?: string;
  agent?: string; model?: string; skills?: string[];
  write?: string; content?: string;
  read?: string;
  if?: string; then?: Step[]; else?: Step[];
  // common:
  when?: string;
  on_failure?: "abort" | "continue" | "retry";
  retries?: number;
  backoff_ms?: number;
  timeout_secs?: number;
  next?: string[];
  next_on_failure?: string;
  position?: NodePosition;
}

export interface RoutineData {
  status?: "enabled" | "disabled";
  cron?: string;
  timezone?: string;
  concurrency?: "skip" | "queue" | "parallel";
  catchup?: boolean;
  tags?: string[];
  steps: Step[];
  // any extra frontmatter fields preserved on round-trip:
  [k: string]: any;
}

export interface ParsedRoutine {
  frontmatter: RoutineData;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseRoutine(raw: string): ParsedRoutine {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    return { frontmatter: { steps: [] }, body: raw };
  }
  const yamlText = m[1];
  let parsed: any = {};
  try { parsed = yaml.load(yamlText) ?? {}; } catch { parsed = {}; }
  if (!Array.isArray(parsed.steps)) parsed.steps = [];
  const body = raw.slice(m[0].length);
  return { frontmatter: parsed as RoutineData, body };
}

export function serializeRoutine(parsed: ParsedRoutine): string {
  const fm = yaml.dump(parsed.frontmatter, { lineWidth: 100, noRefs: true, sortKeys: false });
  return `---\n${fm}---\n${parsed.body ?? ""}`;
}

export function stepKind(s: Step): StepKind {
  if (s.run !== undefined) return "run";
  if (s.agent !== undefined) return "agent";
  if (s.write !== undefined) return "write";
  if (s.read !== undefined) return "read";
  if (s.if !== undefined) return "if";
  return "run";
}

/// Re-key a step's kind fields, clearing those that don't belong.
export function setStepKind(step: Step, kind: StepKind): Step {
  const next: Step = { id: step.id, when: step.when, on_failure: step.on_failure, retries: step.retries, backoff_ms: step.backoff_ms, timeout_secs: step.timeout_secs, next: step.next, next_on_failure: step.next_on_failure, position: step.position };
  switch (kind) {
    case "run":   next.run = step.run ?? "echo hello"; break;
    case "agent": next.agent = step.agent ?? ""; next.model = step.model; next.skills = step.skills; break;
    case "write": next.write = step.write ?? ""; next.content = step.content ?? ""; break;
    case "read":  next.read = step.read ?? ""; break;
    case "if":    next.if = step.if ?? "true"; next.then = step.then ?? []; next.else = step.else ?? []; break;
  }
  return next;
}

export function newStepId(existing: Step[], kind: StepKind): string {
  let i = 1;
  while (existing.some(s => s.id === `${kind}_${i}`)) i++;
  return `${kind}_${i}`;
}

export interface FlowNode { id: string; kind: StepKind; position: NodePosition; data: Step }
export interface FlowEdge { id: string; source: string; target: string; sourceHandle?: "success" | "failure" }

/// Build a graph view from a step list. If steps don't have explicit
/// `next`, infer linear edges from document order so existing routines
/// render as a chain.
export function toGraph(steps: Step[]): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = steps.map((s, i) => ({
    id: s.id,
    kind: stepKind(s),
    position: s.position ?? { x: 80, y: 60 + i * 140 },
    data: s,
  }));
  const explicit = steps.some(s => (s.next && s.next.length) || s.next_on_failure);
  const edges: FlowEdge[] = [];
  if (explicit) {
    for (const s of steps) {
      for (const t of s.next ?? []) {
        edges.push({ id: `${s.id}->${t}`, source: s.id, target: t, sourceHandle: "success" });
      }
      if (s.next_on_failure) {
        edges.push({ id: `${s.id}-fail->${s.next_on_failure}`, source: s.id, target: s.next_on_failure, sourceHandle: "failure" });
      }
    }
  } else {
    // Linear inference from document order.
    for (let i = 0; i < steps.length - 1; i++) {
      edges.push({ id: `${steps[i].id}->${steps[i + 1].id}`, source: steps[i].id, target: steps[i + 1].id, sourceHandle: "success" });
    }
  }
  return { nodes, edges };
}

/// Apply graph back to step list: write `next`, `next_on_failure`,
/// and `position` based on the current node/edge state.
export function fromGraph(steps: Step[], nodes: FlowNode[], edges: FlowEdge[]): Step[] {
  const byId = new Map(steps.map(s => [s.id, s]));
  // Refresh position + data ordering — preserve document order from steps array.
  for (const n of nodes) {
    const s = byId.get(n.id);
    if (s) s.position = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
  }
  // Reset successors then rebuild from edges.
  for (const s of byId.values()) { s.next = []; s.next_on_failure = undefined; }
  for (const e of edges) {
    const src = byId.get(e.source);
    if (!src) continue;
    if (e.sourceHandle === "failure") {
      src.next_on_failure = e.target;
    } else {
      src.next = [...(src.next ?? []), e.target];
    }
  }
  // Drop empty next arrays so YAML stays clean.
  for (const s of byId.values()) {
    if (s.next && s.next.length === 0) delete s.next;
    if (!s.next_on_failure) delete s.next_on_failure;
  }
  return steps;
}
