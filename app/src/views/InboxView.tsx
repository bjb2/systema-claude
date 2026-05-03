import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ViewProps } from "../components/ViewProps";
import DocList from "../components/DocList";
import DocViewer from "../components/DocViewer";
import { AGENT_STYLE, useAgentKaomoji } from "../hooks/useAgentKaomoji";

const FOLDERS = ["all", "captures", "ideas", "decisions", "investigations", "emails", "tickets"];

interface RoutineRun {
  id: string;
  status: "running" | "ok" | "failed";
  context?: {
    trigger?: {
      args?: {
        path?: string;
      };
    };
  };
}

interface SynthesizeState {
  runId: string;
}

function archiveDest(docPath: string, orgRoot: string): string {
  const norm = docPath.replace(/\\/g, "/");
  const filename = norm.split("/").pop() ?? "item.md";
  if (norm.includes("/inbox/emails/")) return `${orgRoot}/archive/emails/${filename}`;
  if (norm.includes("/inbox/tickets/")) return `${orgRoot}/archive/tickets/${filename}`;
  return `${orgRoot}/archive/research/${filename}`;
}

function normPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export default function InboxView({ docs, theme, orgRoot, selectedDoc, setSelectedDoc, onSpawnClaude, onTriggerObserver, observerRunning, onOpenUrl, activePaths }: ViewProps) {
  const [folder, setFolder] = useState("all");
  const [synthesizing, setSynthesizing] = useState<Record<string, SynthesizeState>>({});
  const hasActive = activePaths != null && activePaths.size > 0;
  const hasSynthesizeActive = Object.keys(synthesizing).length > 0;
  const kaomoji = useAgentKaomoji(hasActive || hasSynthesizeActive);

  const loadSynthesizeRuns = useCallback(async () => {
    try {
      const runs = await invoke<RoutineRun[]>("list_runs", {
        name: "synthesize-inbox-item",
        limit: 50,
      });
      const next: Record<string, SynthesizeState> = {};
      for (const run of runs) {
        if (run.status !== "running") continue;
        const path = run.context?.trigger?.args?.path;
        if (!path) continue;
        next[normPath(path)] = { runId: run.id };
      }
      setSynthesizing(next);
    } catch (err) {
      console.error("synthesize run poll failed", err);
    }
  }, []);

  useEffect(() => {
    void loadSynthesizeRuns();
  }, [loadSynthesizeRuns]);

  useEffect(() => {
    if (!hasSynthesizeActive) return;
    const timer = window.setInterval(() => {
      void loadSynthesizeRuns();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasSynthesizeActive, loadSynthesizeRuns]);

  const inbox = useMemo(() =>
    docs
      .filter(d => d.type === "inbox")
      .filter(d => folder === "all" || d.path.includes(`/${folder}/`))
      .sort((a, b) => {
        // Newest first. Prefer `updated` over `created` so an item that was
        // edited today rises above one merely created today.
        const at = a.updated ?? a.created ?? "";
        const bt = b.updated ?? b.created ?? "";
        if (at !== bt) return bt.localeCompare(at);
        // Stable tiebreaker for same-timestamp items: path desc, so the
        // most recently created file (later in fs lex order) wins.
        return b.path.localeCompare(a.path);
      }),
    [docs, folder]
  );

  return (
    <div className="flex h-full">
      <style>{AGENT_STYLE}</style>
      <div className="flex flex-col w-72 flex-shrink-0 border-r" style={{ borderColor: theme.border }}>
        <div className="flex flex-wrap gap-1 p-2 border-b flex-shrink-0" style={{ borderColor: theme.border }}>
          {FOLDERS.map(f => (
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
          {onTriggerObserver && (
            <button
              onClick={onTriggerObserver}
              disabled={observerRunning}
              title={observerRunning ? "Observer already running" : "Run observer agent"}
              className="px-2 py-0.5 text-xs rounded ml-auto"
              style={{
                background: observerRunning ? "transparent" : theme.accentMuted,
                color: observerRunning ? theme.textDim : theme.accent,
                border: `1px solid ${theme.border}`,
                cursor: observerRunning ? "not-allowed" : "pointer",
                opacity: observerRunning ? 0.5 : 1,
              }}
            >
              ヽ༼ຈل͜ຈ༽ﾉ
            </button>
          )}
        </div>
        <DocList
          docs={inbox}
          theme={theme}
          selected={selectedDoc}
          onSelect={setSelectedDoc}
          renderMeta={doc => {
            const isActive = activePaths?.has(doc.path) ?? false;
            const synth = synthesizing[normPath(doc.path)];
            if (synth) {
              return (
                <span
                  className="flex items-center gap-1.5 flex-shrink-0"
                  title={`Synthesize running: ${synth.runId}`}
                >
                  <span style={{ position: "relative", width: 8, height: 8, display: "inline-block" }}>
                    <span style={{
                      position: "absolute", inset: 0, borderRadius: "50%",
                      background: theme.warning,
                      animation: "agentRing 1.2s ease-out infinite",
                    }} />
                    <span style={{
                      position: "absolute", inset: 0, borderRadius: "50%",
                      background: theme.warning,
                      animation: "agentPulse 1.2s ease-in-out infinite",
                    }} />
                  </span>
                  <span style={{ fontSize: 11, color: theme.warning, lineHeight: 1 }}>
                    synth
                  </span>
                </span>
              );
            }
            if (isActive) {
              return (
                <span className="flex items-center gap-1.5 flex-shrink-0">
                  <span style={{ position: "relative", width: 8, height: 8, display: "inline-block" }}>
                    <span style={{
                      position: "absolute", inset: 0, borderRadius: "50%",
                      background: theme.accent,
                      animation: "agentRing 1.2s ease-out infinite",
                    }} />
                    <span style={{
                      position: "absolute", inset: 0, borderRadius: "50%",
                      background: theme.accent,
                      animation: "agentPulse 1.2s ease-in-out infinite",
                    }} />
                  </span>
                  <span style={{ fontSize: 11, color: theme.accent, lineHeight: 1 }}>
                    {kaomoji}
                  </span>
                </span>
              );
            }
            return (
              <span className="text-xs flex-shrink-0" style={{ color: theme.textDim }}>
                {doc.created ?? ""}
              </span>
            );
          }}
        />
      </div>
      <div className="flex-1 overflow-hidden">
        {selectedDoc ? (
          <DocViewer
            key={selectedDoc.path}
            doc={selectedDoc}
            docs={docs}
            theme={theme}
            onClose={() => setSelectedDoc(null)}
            onApprove={onSpawnClaude ? (notes) => {
              const agentId = typeof selectedDoc.frontmatter?.agent === "string" ? selectedDoc.frontmatter.agent : undefined;
              onSpawnClaude(selectedDoc.path, selectedDoc.title, notes || undefined, agentId);
            } : undefined}
            onSynthesize={async () => {
              const path = selectedDoc.path;
              setSynthesizing(prev => ({
                ...prev,
                [normPath(path)]: { runId: "starting" },
              }));
              try {
                const run = await invoke<RoutineRun>("trigger_routine", {
                  name: "synthesize-inbox-item",
                  args: { path },
                });
                setSynthesizing(prev => ({
                  ...prev,
                  [normPath(path)]: { runId: run.id },
                }));
              } catch (err) {
                console.error("synthesize trigger failed", err);
                setSynthesizing(prev => {
                  const next = { ...prev };
                  delete next[normPath(path)];
                  return next;
                });
              }
              void loadSynthesizeRuns();
            }}
            synthesizeRunning={Boolean(synthesizing[normPath(selectedDoc.path)])}
            onDismiss={async () => {
              const dest = archiveDest(selectedDoc.path, orgRoot);
              await invoke("move_file", { src: selectedDoc.path, dst: dest });
              setSelectedDoc(null);
            }}
            onOpenUrl={onOpenUrl}
            onNavigate={setSelectedDoc}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-sm" style={{ color: theme.textDim }}>
            {inbox.length === 0 ? "inbox clear" : "select an item"}
          </div>
        )}
      </div>
    </div>
  );
}
