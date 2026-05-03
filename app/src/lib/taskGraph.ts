// Shared task-graph helpers used by both the Tasks view and the global
// search palette. Keeping `isReady` and the index builder in one place avoids
// the two surfaces drifting in their definition of "ready" or "blocked".

import type { OrgDocument } from "../types";

export interface TaskIndexes {
  byPath: Map<string, OrgDocument>;
  bySlug: Map<string, OrgDocument>;
}

function statusComplete(d: OrgDocument | undefined): boolean {
  return d?.status === "complete";
}

export function buildTaskIndexes(docs: OrgDocument[]): TaskIndexes {
  const byPath = new Map<string, OrgDocument>();
  const bySlug = new Map<string, OrgDocument>();
  for (const d of docs) {
    byPath.set(d.path.replace(/\\/g, "/"), d);
    byPath.set(d.path, d);
    bySlug.set(d.filename.replace(/\.md$/, ""), d);
  }
  return { byPath, bySlug };
}

/** A task is "ready" if every blocked-by target resolves to a complete doc. */
export function isReady(task: OrgDocument, idx: TaskIndexes): boolean {
  if (!task.blockedBy || task.blockedBy.length === 0) return true;
  for (const ref of task.blockedBy) {
    const r = ref.trim().replace(/^\.\//, "");
    if (!r) continue;
    const direct = idx.byPath.get(r) ?? idx.byPath.get(r.replace(/\\/g, "/"));
    if (direct) {
      if (!statusComplete(direct)) return false;
      continue;
    }
    const base = r.split(/[\\/]/).pop() ?? r;
    const slug = base.replace(/\.md$/, "");
    const bySlugHit = idx.bySlug.get(slug);
    if (bySlugHit) {
      if (!statusComplete(bySlugHit)) return false;
      continue;
    }
    // Unresolved reference — be conservative and treat as blocking.
    return false;
  }
  return true;
}

/** A task is "blocked" if it's active and at least one blocker is unresolved. */
export function isBlocked(task: OrgDocument, idx: TaskIndexes): boolean {
  if (task.status !== "active") return false;
  if (!task.blockedBy || task.blockedBy.length === 0) return false;
  return !isReady(task, idx);
}
