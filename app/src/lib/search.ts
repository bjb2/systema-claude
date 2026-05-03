import { OrgDocument } from "../types";
import { buildTaskIndexes, isReady, isBlocked, type TaskIndexes } from "./taskGraph";

export interface SearchResult {
  doc: OrgDocument;
  score: number;
  snippet: string;
  context: string;
  matchIdx: number;
}

export interface SearchFilters {
  kind?: string;
  parent?: string;
  ready?: boolean;
  blocked?: boolean;
  tag?: string;
}

const TOKEN_RE = /\b(kind|parent|ready|blocked|tag):(\S+)/gi;

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTokens(value: string): string[] {
  return normalizeSearchText(value).split(" ").filter(Boolean);
}

function includesAll(haystack: string, tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function pathLabel(path: string): string {
  return path.replace(/\\/g, "/");
}

function parseBool(v: string): boolean {
  const s = v.toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

/** Strip filter tokens out of the query, returning {filters, freeText}. */
export function parseQuery(raw: string): { filters: SearchFilters; text: string } {
  const filters: SearchFilters = {};
  const stripped = raw
    .replace(TOKEN_RE, (_, k: string, v: string) => {
      const key = k.toLowerCase();
      const val = v.toLowerCase();
      if (key === "kind") filters.kind = val;
      else if (key === "parent") filters.parent = val;
      else if (key === "ready") filters.ready = parseBool(val);
      else if (key === "blocked") filters.blocked = parseBool(val);
      else if (key === "tag") filters.tag = val;
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { filters, text: stripped };
}

function matchesFilters(
  doc: OrgDocument,
  filters: SearchFilters,
  idx: TaskIndexes,
): boolean {
  if (filters.kind) {
    const k = (doc.kind ?? (doc.type === "task" ? "task" : "")).toLowerCase();
    if (k !== filters.kind) return false;
  }
  if (filters.parent) {
    const p = (doc.parent ?? "").toLowerCase().replace(/\\/g, "/");
    if (!p.includes(filters.parent)) return false;
  }
  if (filters.tag) {
    const tag = filters.tag;
    if (!doc.tags.some((t) => t.toLowerCase() === tag)) return false;
  }
  if (filters.ready !== undefined) {
    if (doc.type !== "task") return false;
    const ready = isReady(doc, idx);
    if (filters.ready !== ready) return false;
  }
  if (filters.blocked !== undefined) {
    if (doc.type !== "task") return false;
    const blocked = isBlocked(doc, idx);
    if (filters.blocked !== blocked) return false;
  }
  return true;
}

export function searchDocs(docs: OrgDocument[], query: string): SearchResult[] {
  const { filters, text } = parseQuery(query);
  const hasFilter = Object.keys(filters).length > 0;
  const q = text.toLowerCase().trim();
  if (!q && !hasFilter) return [];

  const idx = hasFilter ? buildTaskIndexes(docs) : ({ byPath: new Map(), bySlug: new Map() } as TaskIndexes);
  const filtered = hasFilter ? docs.filter((d) => matchesFilters(d, filters, idx)) : docs;

  if (!q) {
    // Pure-filter mode — return all matching docs sorted by title.
    return filtered
      .map((doc) => ({ doc, score: 1, snippet: "", context: pathLabel(doc.path), matchIdx: -1 }))
      .sort((a, b) => a.doc.title.localeCompare(b.doc.title));
  }

  return filtered
    .map((doc) => scoreDoc(doc, q))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

function scoreDoc(doc: OrgDocument, q: string): SearchResult {
  const qNorm = normalizeSearchText(q);
  const tokens = searchTokens(q);
  const titleLower = doc.title.toLowerCase();
  const contentLower = doc.content.toLowerCase();
  const titleNorm = normalizeSearchText(doc.title);
  const contentNorm = normalizeSearchText(doc.content);
  const docPath = pathLabel(doc.path);
  const pathNorm = normalizeSearchText(docPath);
  const tagsNorm = normalizeSearchText(doc.tags.join(" "));
  const typeNorm = normalizeSearchText(doc.type);

  const titleMatch = titleLower.includes(q) || titleNorm.includes(qNorm) || includesAll(titleNorm, tokens);
  const contentIdx = contentLower.indexOf(q);
  const firstTokenIdx = tokens
    .map((token) => contentLower.indexOf(token))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0] ?? -1;

  let score = 0;
  if (titleLower.includes(q) || titleNorm.includes(qNorm)) score += 20;
  else if (titleMatch) score += 14;
  if (pathNorm.includes(qNorm)) score += 10;
  else if (includesAll(pathNorm, tokens)) score += 8;
  if (tagsNorm.includes(qNorm) || includesAll(tagsNorm, tokens)) score += 4;
  if (typeNorm === qNorm) score += 3;
  if (contentIdx >= 0) score += 3;
  else if (includesAll(contentNorm, tokens)) score += 1;

  let snippet = "";
  const snippetIdx = contentIdx >= 0 ? contentIdx : firstTokenIdx;
  if (snippetIdx >= 0) {
    const start = Math.max(0, snippetIdx - 60);
    const end = Math.min(doc.content.length, snippetIdx + q.length + 60);
    snippet = doc.content.slice(start, end).replace(/\n+/g, " ").trim();
  }
  return { doc, score, snippet, context: docPath, matchIdx: contentIdx };
}

export function highlightMatch(text: string, query: string): string {
  if (!query) return text;
  // Strip filter tokens from the query before highlighting; only highlight
  // the residual free-text portion.
  const { text: free } = parseQuery(query);
  const q = free.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text;
  return (
    text.slice(0, idx) +
    "<mark>" +
    text.slice(idx, idx + q.length) +
    "</mark>" +
    text.slice(idx + q.length)
  );
}
