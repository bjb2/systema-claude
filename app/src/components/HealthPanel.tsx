import { useMemo } from "react";
import { Theme } from "../themes";
import { OrgDocument } from "../types";

interface HealthPanelProps {
  docs: OrgDocument[];
  theme: Theme;
}

interface BrokenLink {
  source: OrgDocument;
  target: string;
}

interface LintWarning {
  doc: OrgDocument;
  problems: string[];
}

function normalizePath(p: string): string {
  const s = p.replace(/\\/g, "/");
  if (s.length >= 2 && s[1] === ":" && /[a-zA-Z]/.test(s[0])) {
    return s[0].toLowerCase() + s.slice(1);
  }
  return s;
}

function basenameOf(p: string): string {
  const s = p.replace(/\\/g, "/");
  const idx = s.lastIndexOf("/");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

const FENCED_BLOCK = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE = /`[^`\n]*`/g;
const WIKILINK = /\[\[([^\]\n|]+?)(?:\|[^\]\n]*)?\]\]/g;

// Re-extract wikilinks from content, ignoring fenced and inline code.
// orgd's graph pass currently extracts [[...]] inside code blocks, which
// produces ~100+ false-positive "broken links" like [[slug]], [[base]],
// [[wikilinks]] from documentation/code examples. See
// knowledge/system/graph-health-pipeline.md.
function extractCleanLinks(content: string): string[] {
  if (!content) return [];
  const stripped = content.replace(FENCED_BLOCK, "").replace(INLINE_CODE, "");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = WIKILINK.exec(stripped)) !== null) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}

interface HealthMetrics {
  orphans: OrgDocument[];
  brokenLinks: BrokenLink[];
  lintWarnings: LintWarning[];
  totalOrphans: number;
  totalBroken: number;
  totalLint: number;
}

function computeMetrics(docs: OrgDocument[]): HealthMetrics {
  // Build resolution indexes mirroring orgd's DocIndex
  const byPath = new Map<string, OrgDocument>();
  const byBasename = new Map<string, OrgDocument>();
  const bySlug = new Map<string, OrgDocument>();
  for (const d of docs) {
    byPath.set(normalizePath(d.path), d);
    byBasename.set(d.filename, d);
    bySlug.set(d.filename.replace(/\.md$/, ""), d);
  }

  const resolve = (ref: string): OrgDocument | undefined => {
    const trimmed = ref.trim().replace(/^\.\//, "");
    if (!trimmed) return undefined;
    const normalized = normalizePath(trimmed);
    const direct = byPath.get(normalized);
    if (direct) return direct;
    const base = basenameOf(trimmed);
    const baseMd = base.endsWith(".md") ? base : `${base}.md`;
    const byBase = byBasename.get(baseMd);
    if (byBase) return byBase;
    const slug = base.replace(/\.md$/, "");
    return bySlug.get(slug);
  };

  // Reverse index: for each doc, who links TO it?
  const incoming = new Map<string, number>();
  const brokenLinks: BrokenLink[] = [];
  for (const d of docs) {
    incoming.set(normalizePath(d.path), 0);
  }
  // Cache cleaned links per doc so orphan calculation stays consistent.
  const cleanLinksByPath = new Map<string, string[]>();
  for (const d of docs) {
    cleanLinksByPath.set(normalizePath(d.path), extractCleanLinks(d.content));
  }

  for (const d of docs) {
    const links = cleanLinksByPath.get(normalizePath(d.path)) ?? [];
    for (const link of links) {
      const target = resolve(link);
      if (target) {
        const key = normalizePath(target.path);
        incoming.set(key, (incoming.get(key) ?? 0) + 1);
      } else {
        brokenLinks.push({ source: d, target: link });
      }
    }
  }

  // Orphans: no outgoing links AND no incoming links
  const orphansAll: OrgDocument[] = [];
  for (const d of docs) {
    const out = (cleanLinksByPath.get(normalizePath(d.path))?.length ?? 0) > 0;
    const inc = (incoming.get(normalizePath(d.path)) ?? 0) > 0;
    if (!out && !inc) orphansAll.push(d);
  }

  // Frontmatter lint
  const lintAll: LintWarning[] = [];
  for (const d of docs) {
    const problems: string[] = [];
    if (d.type === "task") {
      if (!d.status) problems.push("missing status");
      if (!d.created) problems.push("missing created");
    } else if (d.type === "knowledge") {
      if (!d.tags || d.tags.length === 0) problems.push("missing tags");
      if (!d.updated) problems.push("missing updated");
    }
    if (problems.length > 0) lintAll.push({ doc: d, problems });
  }

  return {
    orphans: orphansAll.slice(0, 10),
    brokenLinks: brokenLinks.slice(0, 10),
    lintWarnings: lintAll.slice(0, 10),
    totalOrphans: orphansAll.length,
    totalBroken: brokenLinks.length,
    totalLint: lintAll.length,
  };
}

export default function HealthPanel({ docs, theme }: HealthPanelProps) {
  const metrics = useMemo(() => computeMetrics(docs), [docs]);

  const sectionStyle = { background: theme.bgSecondary, borderColor: theme.border };

  const renderRow = (key: string, primary: string, secondary?: string) => (
    <div
      key={key}
      className="flex items-center gap-3 px-4 py-2 border rounded text-sm"
      style={sectionStyle}
    >
      <span style={{ color: theme.warning }}>!</span>
      <span style={{ color: theme.text }} className="truncate">{primary}</span>
      {secondary && (
        <span className="ml-auto text-xs font-mono truncate" style={{ color: theme.textDim }}>
          {secondary}
        </span>
      )}
    </div>
  );

  return (
    <section className="mb-8 mt-8">
      <h2
        className="text-sm font-semibold mb-3 uppercase tracking-widest"
        style={{ color: theme.textDim }}
      >
        Org Health
      </h2>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="p-4 border rounded" style={sectionStyle}>
          <div
            className="text-2xl font-bold"
            style={{ color: metrics.totalOrphans > 0 ? theme.warning : theme.accent }}
          >
            {metrics.totalOrphans}
          </div>
          <div className="text-xs mt-1" style={{ color: theme.textMuted }}>orphan articles</div>
        </div>
        <div className="p-4 border rounded" style={sectionStyle}>
          <div
            className="text-2xl font-bold"
            style={{ color: metrics.totalBroken > 0 ? theme.warning : theme.accent }}
          >
            {metrics.totalBroken}
          </div>
          <div className="text-xs mt-1" style={{ color: theme.textMuted }}>broken wikilinks</div>
        </div>
        <div className="p-4 border rounded" style={sectionStyle}>
          <div
            className="text-2xl font-bold"
            style={{ color: metrics.totalLint > 0 ? theme.warning : theme.accent }}
          >
            {metrics.totalLint}
          </div>
          <div className="text-xs mt-1" style={{ color: theme.textMuted }}>frontmatter warnings</div>
        </div>
      </div>

      {metrics.orphans.length > 0 && (
        <div className="mb-4">
          <div
            className="text-xs uppercase tracking-wider mb-2"
            style={{ color: theme.textMuted }}
          >
            Orphans (no incoming or outgoing links)
            {metrics.totalOrphans > metrics.orphans.length && ` · showing ${metrics.orphans.length} of ${metrics.totalOrphans}`}
          </div>
          <div className="space-y-2">
            {metrics.orphans.map(d => renderRow(d.path, d.title || d.filename, d.path))}
          </div>
        </div>
      )}

      {metrics.brokenLinks.length > 0 && (
        <div className="mb-4">
          <div
            className="text-xs uppercase tracking-wider mb-2"
            style={{ color: theme.textMuted }}
          >
            Broken wikilinks
            {metrics.totalBroken > metrics.brokenLinks.length && ` · showing ${metrics.brokenLinks.length} of ${metrics.totalBroken}`}
          </div>
          <div className="space-y-2">
            {metrics.brokenLinks.map((bl, i) =>
              renderRow(
                `${bl.source.path}::${bl.target}::${i}`,
                `${bl.source.title || bl.source.filename} → [[${bl.target}]]`,
                bl.source.path
              )
            )}
          </div>
        </div>
      )}

      {metrics.lintWarnings.length > 0 && (
        <div className="mb-4">
          <div
            className="text-xs uppercase tracking-wider mb-2"
            style={{ color: theme.textMuted }}
          >
            Frontmatter warnings
            {metrics.totalLint > metrics.lintWarnings.length && ` · showing ${metrics.lintWarnings.length} of ${metrics.totalLint}`}
          </div>
          <div className="space-y-2">
            {metrics.lintWarnings.map(lw =>
              renderRow(
                lw.doc.path,
                `${lw.doc.title || lw.doc.filename} · ${lw.problems.join(", ")}`,
                lw.doc.path
              )
            )}
          </div>
        </div>
      )}
    </section>
  );
}
