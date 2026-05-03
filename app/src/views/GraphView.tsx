import { useEffect, useRef, useMemo, useState } from "react";
import * as d3 from "d3";
import { ViewProps } from "../components/ViewProps";
import { OrgDocument } from "../types";
import DocViewer from "../components/DocViewer";

const MIN_PANEL_W = 280;
const MAX_PANEL_W = 1100;
const DEFAULT_PANEL_W = 384;
const ORPHAN_REPORT_RE = /(^|\/)knowledge\/system\/orphans-\d{4}-\d{2}-\d{2}\.md$/;

interface Node extends d3.SimulationNodeDatum {
  id: string;
  title: string;
  type: string;
}

interface Link extends d3.SimulationLinkDatum<Node> {
  source: string | Node;
  target: string | Node;
}

export default function GraphView({ docs, theme, selectedDoc, setSelectedDoc, onOpenUrl }: ViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [showReports, setShowReports] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem("graphPanelWidth");
    return saved ? Number(saved) : DEFAULT_PANEL_W;
  });
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    localStorage.setItem("graphPanelWidth", String(panelWidth));
  }, [panelWidth]);

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: panelWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const next = Math.max(
        MIN_PANEL_W,
        Math.min(
          MAX_PANEL_W,
          dragRef.current.startW + (dragRef.current.startX - ev.clientX),
        ),
      );
      setPanelWidth(next);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const { nodes, links, hiddenCount } = useMemo(() => {
    // Use the full path as the node id so files with duplicate basenames
    // (every README.md, every index.md, etc.) don't collide.
    const norm = (p: string) => p.replace(/\\/g, "/");
    const basename = (p: string) => norm(p).split("/").pop()?.replace(/\.md$/, "") ?? "";
    const isReportNode = (d: OrgDocument) => {
      const path = norm(d.path);
      return ORPHAN_REPORT_RE.test(path) || path === "tasks/completed/SUMMARY.md";
    };
    const graphDocs = showReports ? docs : docs.filter(d => !isReportNode(d));
    const hiddenCount = docs.length - graphDocs.length;
    const graphDocPaths = new Set(graphDocs.map(d => norm(d.path)));
    const byPath = new Map(graphDocs.map(d => [norm(d.path), d]));
    // Index docs by basename for wikilink fallback. Multiple docs may share a
    // basename, so values are arrays.
    const byBase = new Map<string, OrgDocument[]>();
    graphDocs.forEach(d => {
      const b = basename(d.path);
      const arr = byBase.get(b);
      if (arr) arr.push(d); else byBase.set(b, [d]);
    });

    const nodes: Node[] = graphDocs.map(d => ({
      id: norm(d.path),
      title: d.title,
      type: d.type,
    }));

    // Resolve a wikilink target to a node id (full path). Prefers an exact
    // path-suffix match so [[knowledge/README]] disambiguates from
    // [[tasks/README]]; falls back to bare basename when unambiguous.
    const resolveLink = (link: string, sourcePath: string): string | null => {
      const cleaned = link.replace(/\.md$/, "");
      const suffix = norm(cleaned);
      if (suffix.includes("/")) {
        for (const p of byPath.keys()) {
          if (p === suffix || p.endsWith("/" + suffix) || p.endsWith("/" + suffix + ".md")) {
            return p;
          }
        }
      }
      const base = basename(cleaned);
      const matches = byBase.get(base);
      if (!matches || matches.length === 0) return null;
      if (matches.length === 1) return norm(matches[0].path);
      // Ambiguous bare basename: prefer a doc in the same directory as the
      // source, otherwise leave unresolved rather than guess.
      const srcDir = norm(sourcePath).replace(/\/[^/]+$/, "");
      const sameDir = matches.find(m => norm(m.path).replace(/\/[^/]+$/, "") === srcDir);
      return sameDir ? norm(sameDir.path) : null;
    };

    const links: Link[] = [];
    graphDocs.forEach(d => {
      const sourceId = norm(d.path);
      d.links.forEach(link => {
        const target = resolveLink(link, d.path);
        if (target && graphDocPaths.has(target)) links.push({ source: sourceId, target });
      });
    });
    return { nodes, links, hiddenCount };
  }, [docs, showReports]);

  useEffect(() => {
    const svg = d3.select(svgRef.current!);
    svg.selectAll("*").remove();
    const el = svgRef.current;
    if (!el) return;
    const W = el.clientWidth;
    const H = el.clientHeight;

    const TYPE_COLORS: Record<string, string> = {
      task: theme.accent,
      knowledge: "#4ac8f0",
      inbox: theme.warning,
      reminder: "#f04878",
      project: "#c84af0",
    };

    const degree = new Map<string, number>();
    links.forEach(l => {
      const s = typeof l.source === "string" ? l.source : l.source.id;
      const t = typeof l.target === "string" ? l.target : l.target.id;
      degree.set(s, (degree.get(s) ?? 0) + 1);
      degree.set(t, (degree.get(t) ?? 0) + 1);
    });
    const radius = (d: Node) => 4 + Math.sqrt(degree.get(d.id) ?? 0) * 2.2;

    const sim = d3.forceSimulation<Node>(nodes)
      .force("link", d3.forceLink<Node, Link>(links).id(d => d.id).distance(80))
      .force("charge", d3.forceManyBody().strength(-150))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collision", d3.forceCollide<Node>(d => radius(d) + 4));

    const g = svg.append("g");

    svg.call(
      d3.zoom<SVGSVGElement, unknown>().on("zoom", e => g.attr("transform", e.transform.toString()))
    );

    const link = g.append("g")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke", theme.border)
      .attr("stroke-width", 1);

    const node = g.append("g")
      .selectAll("circle")
      .data(nodes)
      .join("circle")
      .attr("r", d => radius(d))
      .attr("fill", d => TYPE_COLORS[d.type] ?? theme.textMuted)
      .attr("stroke", theme.bg)
      .attr("stroke-width", 2)
      .style("cursor", "pointer")
      .on("click", (event, d) => {
        event.stopPropagation();
        const doc = docs.find(doc => doc.path.replace(/\\/g, "/") === d.id);
        if (doc) setSelectedDoc(doc);
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .call(d3.drag<SVGCircleElement, Node>()
          .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
          .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
          .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }) as any
      );

    const label = g.append("g")
      .selectAll("text")
      .data(nodes)
      .join("text")
      .text(d => d.title.slice(0, 20))
      .attr("font-size", 9)
      .attr("fill", theme.textMuted)
      .attr("font-family", "monospace")
      .attr("dy", d => -(radius(d) + 3))
      .attr("text-anchor", "middle")
      .style("pointer-events", "none");

    sim.on("tick", () => {
      link
        .attr("x1", d => (d.source as Node).x ?? 0)
        .attr("y1", d => (d.source as Node).y ?? 0)
        .attr("x2", d => (d.target as Node).x ?? 0)
        .attr("y2", d => (d.target as Node).y ?? 0);
      node.attr("cx", d => d.x ?? 0).attr("cy", d => d.y ?? 0);
      label.attr("x", d => d.x ?? 0).attr("y", d => d.y ?? 0);
    });

    return () => { sim.stop(); };
  }, [nodes, links, theme, docs, setSelectedDoc]);

  return (
    <div className="h-full flex">
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="px-4 py-2 text-xs border-b flex-shrink-0" style={{ borderColor: theme.border, color: theme.textDim }}>
          {nodes.length} nodes · {links.length} links · click to open · scroll to zoom · drag to pan
        </div>
        <label
          className="px-4 py-1 text-xs border-b flex-shrink-0 inline-flex items-center gap-2"
          style={{ borderColor: theme.border, color: theme.textDim }}
        >
          <input
            type="checkbox"
            checked={showReports}
            onChange={(e) => setShowReports(e.target.checked)}
          />
          <span>Show generated reports and summaries{hiddenCount > 0 && !showReports ? ` (${hiddenCount} hidden)` : ""}</span>
        </label>
        <svg ref={svgRef} className="flex-1 w-full" style={{ background: theme.bg }} />
      </div>
      {selectedDoc && (
        <div
          className="flex-shrink-0 border-l overflow-hidden"
          style={{ borderColor: theme.border, width: panelWidth, position: "relative" }}
        >
          <div
            onMouseDown={handleDragStart}
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
          <DocViewer key={selectedDoc.path} doc={selectedDoc} docs={docs} theme={theme} onClose={() => setSelectedDoc(null)} onOpenUrl={onOpenUrl} onNavigate={setSelectedDoc} />
        </div>
      )}
    </div>
  );
}
