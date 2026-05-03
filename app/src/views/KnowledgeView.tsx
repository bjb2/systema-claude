import { useMemo, useState } from "react";
import { ViewProps } from "../components/ViewProps";
import DocList from "../components/DocList";
import DocViewer from "../components/DocViewer";
import { OrgDocument } from "../types";

function knowledgeFolder(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const match = norm.match(/knowledge\/([^/]+)\//);
  return match ? match[1] : "general";
}

// Project name extracted from the leading "ProjectName: " segment of a
// knowledge title, if present. Falls through to null otherwise — the user
// develops their own project taxonomy through use; we ship no presets.
function extractKnowledgeProject(doc: OrgDocument): string | null {
  const titleMatch = doc.title.match(/^([A-Za-z][A-Za-z0-9\-\.]+):\s/i);
  if (titleMatch) {
    return titleMatch[1].toLowerCase().replace(/\./g, "-");
  }
  return null;
}

export default function KnowledgeView({ docs, theme, selectedDoc, setSelectedDoc, onOpenUrl }: ViewProps) {
  const [folder, setFolder] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  const knowledgeDocs = useMemo(() => docs.filter(d => d.type === "knowledge"), [docs]);

  const folders = useMemo(() => {
    const seen = new Set<string>();
    knowledgeDocs.forEach(d => seen.add(knowledgeFolder(d.path)));
    return ["all", ...Array.from(seen).sort()];
  }, [knowledgeDocs]);

  const knowledgeProjects = useMemo(() => {
    const seen = new Set<string>();
    knowledgeDocs.forEach(d => {
      const p = extractKnowledgeProject(d);
      if (p) seen.add(p);
    });
    return ["all", ...Array.from(seen).sort()];
  }, [knowledgeDocs]);

  const knowledge = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return knowledgeDocs
      .filter(d => folder === "all" || knowledgeFolder(d.path) === folder)
      .filter(d => {
        if (projectFilter === "all") return true;
        return extractKnowledgeProject(d) === projectFilter;
      })
      .filter(d => !q || d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q))
      .sort((a, b) => {
        const at = a.updated ?? a.created ?? "";
        const bt = b.updated ?? b.created ?? "";
        if (at !== bt) return bt.localeCompare(at);
        // Stable tiebreaker for same-timestamp docs: path desc.
        return b.path.localeCompare(a.path);
      });
  }, [knowledgeDocs, folder, projectFilter, searchQuery]);

  return (
    <div className="flex h-full">
      <div className="flex flex-col w-72 flex-shrink-0 border-r" style={{ borderColor: theme.border }}>
        <div className="p-2 border-b flex-shrink-0" style={{ borderColor: theme.border }}>
          <input
            type="text"
            placeholder="search knowledge..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full bg-transparent text-sm outline-none px-2 py-1 rounded border"
            style={{ borderColor: theme.border, color: theme.text }}
          />
        </div>
        <div className="flex flex-wrap gap-1 p-2 border-b flex-shrink-0" style={{ borderColor: theme.border }}>
          {folders.map(f => (
            <button
              key={f}
              onClick={() => setFolder(f)}
              className="px-2 py-0.5 text-xs rounded"
              style={{
                background: folder === f ? theme.accentMuted : "transparent",
                color: folder === f ? theme.accent : theme.textDim,
              }}
            >
              {f}
            </button>
          ))}
        </div>
        {knowledgeProjects.length > 2 && (
          <div className="flex flex-wrap gap-1 p-2 border-b flex-shrink-0" style={{ borderColor: theme.border }}>
            {knowledgeProjects.map(p => (
              <button
                key={p}
                onClick={() => setProjectFilter(p)}
                className="px-2 py-0.5 text-xs rounded"
                style={{
                  background: projectFilter === p ? theme.accentMuted : "transparent",
                  color: projectFilter === p ? theme.accent : theme.textDim,
                }}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        <DocList
          docs={knowledge}
          theme={theme}
          selected={selectedDoc}
          onSelect={setSelectedDoc}
          renderMeta={d => (
            <span className="flex flex-col items-end gap-0.5 flex-shrink-0">
              {folder === "all" ? (
                <span className="text-xs" style={{ color: theme.accent, opacity: 0.6 }}>
                  {knowledgeFolder(d.path)}
                </span>
              ) : d.tags.length > 0 ? (
                <span className="text-xs max-w-[88px] truncate" style={{ color: theme.accent, opacity: 0.6 }}>
                  {d.tags.slice(0, 2).join(" · ")}
                </span>
              ) : null}
              <span className="text-xs" style={{ color: theme.textDim }}>
                {d.updated ?? d.created ?? ""}
              </span>
            </span>
          )}
        />
      </div>
      <div className="flex-1 overflow-hidden">
        {selectedDoc ? (
          <DocViewer key={selectedDoc.path} doc={selectedDoc} docs={docs} theme={theme} onClose={() => setSelectedDoc(null)} onOpenUrl={onOpenUrl} onNavigate={setSelectedDoc} />
        ) : (
          <div className="h-full flex items-center justify-center text-sm" style={{ color: theme.textDim }}>
            select an article
          </div>
        )}
      </div>
    </div>
  );
}
