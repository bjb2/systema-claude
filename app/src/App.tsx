import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { themes, ViewKey } from "./themes";
import { OrgDocument } from "./types";
import Sidebar from "./components/Sidebar";
import Header from "./components/Header";
import DashboardView from "./views/DashboardView";
import TasksView from "./views/TasksView";
import KnowledgeView from "./views/KnowledgeView";
import InboxView from "./views/InboxView";
import GraphView from "./views/GraphView";
import CodeView from "./views/CodeView";
import TerminalView from "./views/TerminalView";
import SwarmView, { MAX_SLOTS } from "./views/SwarmView";
import RoutinesView from "./views/RoutinesView";
import SettingsView from "./views/SettingsView";
import { TileConfig } from "./components/AgentTile";
import { pickAgentName } from "./lib/agentNames";
import { AgentRegistry, resolveAgent, DEFAULT_PRIMER } from "./lib/agents";
import SearchPalette from "./components/SearchPalette";
import NewTaskModal from "./components/NewTaskModal";

const VIEW_KEYS: Record<string, ViewKey> = {
  "1": "dashboard",
  "2": "tasks",
  "3": "knowledge",
  "4": "inbox",
  "5": "graph",
  "6": "code",
  "0": "swarm",
  "8": "routines",
};

let tileCounter = 0;
function nextTileId() { return `tile-${Date.now()}-${++tileCounter}`; }


export default function App() {
  const [themeIdx, setThemeIdx] = useState(0);
  const [view, setView] = useState<ViewKey>("dashboard");
  const [docs, setDocs] = useState<OrgDocument[]>([]);
  const [orgRoot, setOrgRoot] = useState<string>("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<OrgDocument | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalWidth, setTerminalWidth] = useState(480);
  const termDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // Always start with a fresh swarm. Persisting tile metadata across restarts
  // doesn't preserve the PTYs (they die with the app), so restoring just respawns
  // fresh agents and re-fires their prompts — exactly the "old session kicks off
  // again" failure mode. Drop the legacy entry so it doesn't grow stale.
  const [swarmTiles, setSwarmTiles] = useState<TileConfig[]>(() => {
    try {
      const raw = localStorage.getItem("swarmTiles");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as Array<Partial<TileConfig> & { x?: number; y?: number; width?: number; height?: number; zIndex?: number }>;
      // Migrate legacy positional persistence to the slot model.
      // Drop any tiles past the cap (preserves spawn order).
      return parsed.slice(0, MAX_SLOTS).map((t, i) => ({
        id: t.id ?? `tile-${Date.now()}-${i}`,
        type: t.type,
        title: t.title ?? "agent",
        slot: i,
        taskPath: t.taskPath ?? null,
        projectRoot: t.projectRoot ?? "",
        promptSuffix: t.promptSuffix,
        promptOverride: t.promptOverride,
        agentId: t.agentId,
        agentLabel: t.agentLabel,
        launchCmd: t.launchCmd,
        launchArgs: t.launchArgs,
        submitKey: t.submitKey,
        ptyId: t.ptyId,
        workerId: t.workerId,
      }));
    } catch {}
    return [];
  });
  const [focusedSlot, setFocusedSlot] = useState<number | null>(null);
  const focusedSlotRef = useRef<number | null>(null);
  useEffect(() => { focusedSlotRef.current = focusedSlot; }, [focusedSlot]);
  const tilePtyIdsRef = useRef<Map<string, number>>(new Map());
  const swarmTilesRef = useRef(swarmTiles);
  useEffect(() => {
    swarmTilesRef.current = swarmTiles;
    try { localStorage.setItem("swarmTiles", JSON.stringify(swarmTiles)); } catch {}
  }, [swarmTiles]);
  const [agentRegistry, setAgentRegistry] = useState<AgentRegistry | null>(null);

  const theme = themes[themeIdx];

  const loadDocs = useCallback(async () => {
    try {
      const result = await invoke<OrgDocument[]>("get_documents");
      setDocs(result);
    } catch (e) {
      console.error("Failed to load docs:", e);
    }
  }, []);

  const loadOrgRoot = useCallback(async () => {
    try {
      const root = await invoke<string>("get_org_root");
      setOrgRoot(root);
    } catch (e) {
      console.error("Failed to get org root:", e);
    }
  }, []);

  const loadAgentRegistry = useCallback(async () => {
    try {
      const json = await invoke<string>("read_org_config");
      setAgentRegistry(JSON.parse(json) as AgentRegistry);
    } catch {
      // Falls back to claude defaults when org.config.json is absent
    }
  }, []);

  const handleRegistryChange = useCallback((registry: AgentRegistry) => {
    setAgentRegistry(registry);
  }, []);

  useEffect(() => {
    loadDocs();
    loadOrgRoot();
    loadAgentRegistry();
    const unlisten = listen("org-changed", () => { loadDocs(); loadAgentRegistry(); });
    return () => { unlisten.then(f => f()); };
  }, [loadDocs, loadOrgRoot, loadAgentRegistry]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Modifier shortcuts work everywhere, including inside inputs.
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setNewTaskOpen(true);
        return;
      }

      // Ctrl+Shift+1..6 → focus swarm slot
      if (e.ctrlKey && e.shiftKey && /^[1-6]$/.test(e.key)) {
        const targetSlot = parseInt(e.key, 10) - 1;
        const tile = swarmTilesRef.current.find(t => t.slot === targetSlot);
        if (tile) {
          e.preventDefault();
          setFocusedSlot(targetSlot);
        }
        return;
      }

      // Ctrl+0 → clear slot promotion (canonical proportions)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "0" || e.code === "Digit0")) {
        e.preventDefault();
        setFocusedSlot(null);
        return;
      }

      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return;

      if (e.ctrlKey && e.key === "k") {
        e.preventDefault();
        setSearchOpen(o => !o);
      } else if (e.key === "`") {
        setTerminalOpen(o => !o);
      } else if (e.key === "s") {
        setView("settings");
        setSelectedDoc(null);
      } else if (VIEW_KEYS[e.key]) {
        setView(VIEW_KEYS[e.key]);
        setSelectedDoc(null);
      } else if (e.key === "t") {
        setThemeIdx(i => (i + 1) % themes.length);
      } else if (e.key === "Escape") {
        setSelectedDoc(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const addTile = useCallback((taskPath: string | null, _title: string, root: string, promptSuffix?: string, agentId?: string) => {
    const agentCfg = resolveAgent(agentId, agentRegistry);
    // Prime blank-launch agents (no task) so they orient themselves on startup.
    // Tasks already supply their own message via the taskPath branch in AgentTile.
    const promptOverride = !taskPath
      ? (agentCfg.primer ?? DEFAULT_PRIMER)
      : undefined;
    setSwarmTiles(prev => {
      if (prev.length >= MAX_SLOTS) return prev;
      return [...prev, {
        id: nextTileId(),
        title: pickAgentName(agentCfg.id),
        slot: prev.length,
        taskPath,
        projectRoot: root,
        promptSuffix,
        promptOverride,
        agentId: agentCfg.id,
        agentLabel: agentCfg.label,
        launchCmd: agentCfg.launchCmd,
        launchArgs: agentCfg.launchArgs,
        submitKey: agentCfg.submitKey,
      }];
    });
  }, [agentRegistry]);

  const onSpawnClaude = useCallback((path: string, title: string, notes?: string, agentId?: string) => {
    addTile(path, title, orgRoot, notes, agentId);
  }, [addTile, orgRoot]);

  const observerRunning = useMemo(
    () => swarmTiles.some(t => t.title === "observer"),
    [swarmTiles],
  );

  const handleTriggerObserver = useCallback(() => {
    if (observerRunning) return;
    setSwarmTiles(prev => {
      if (prev.length >= MAX_SLOTS) return prev;
      return [...prev, {
        id: nextTileId(),
        title: "observer",
        slot: prev.length,
        taskPath: `${orgRoot}/setup/agents/observer.md`,
        projectRoot: orgRoot,
      }];
    });
    setView("swarm");
  }, [observerRunning, orgRoot]);

  const handleTileFocus = useCallback((id: string) => {
    setSwarmTiles(prev => {
      const t = prev.find(x => x.id === id);
      if (t) setFocusedSlot(t.slot);
      return prev;
    });
  }, []);

  const handleTilePtyReady = useCallback((id: string, ptyId: number) => {
    tilePtyIdsRef.current.set(id, ptyId);
    setSwarmTiles(prev => prev.map(t => t.id === id ? { ...t, ptyId } : t));
  }, []);

  const handleTileWorkerReady = useCallback((id: string, workerId: number) => {
    setSwarmTiles(prev => prev.map(t => t.id === id ? { ...t, workerId } : t));
  }, []);

  const handleTileClose = useCallback((id: string) => {
    tilePtyIdsRef.current.delete(id);
    setSwarmTiles(prev => {
      const next = prev.filter(t => t.id !== id);
      // Re-pack slots so they remain contiguous 0..N-1.
      return next
        .sort((a, b) => a.slot - b.slot)
        .map((t, i) => ({ ...t, slot: i }));
    });
    setFocusedSlot(prev => {
      if (prev === null) return null;
      // If the closed tile was focused, clear focus; otherwise the index may
      // shift after re-packing — clear to avoid stale focus on the wrong tile.
      return null;
    });
  }, []);

  const handleAddShell = useCallback(() => {
    setView("swarm");
    addTile(null, "Shell", orgRoot);
  }, [addTile, orgRoot]);

  const handleAddAgent = useCallback((agentId: string) => {
    setView("swarm");
    addTile(null, agentId, orgRoot, undefined, agentId);
  }, [addTile, orgRoot]);

  const handleResetLayout = useCallback(() => {
    setFocusedSlot(null);
  }, []);

  const getSwarmTargets = useCallback((): { title: string; ptyId: number }[] => {
    const active = swarmTilesRef.current
      .filter(t => tilePtyIdsRef.current.has(t.id))
      .sort((a, b) => a.slot - b.slot);
    // If a slot is focused, push it to the end so consumers that pick the last
    // entry get the most recently focused agent (preserves the prior contract).
    const focused = focusedSlotRef.current;
    if (focused !== null) {
      const i = active.findIndex(t => t.slot === focused);
      if (i >= 0) active.push(...active.splice(i, 1));
    }
    return active.map(t => ({ title: t.title, ptyId: tilePtyIdsRef.current.get(t.id)! }));
  }, []);

  const activePaths = useMemo(
    () => new Set(swarmTiles.map(t => t.taskPath).filter(Boolean) as string[]),
    [swarmTiles],
  );

  const viewProps = {
    docs, theme, orgRoot, selectedDoc, setSelectedDoc,
    onSpawnClaude,
    onTriggerObserver: handleTriggerObserver,
    observerRunning,
    onOpenUrl: (url: string) => {
      invoke("open_external_url", { url }).catch(console.error);
    },
    activePaths,
  };

  return (
    <div className="flex flex-col h-full" style={{ background: theme.bg, color: theme.text }}>
      {searchOpen && (
        <SearchPalette
          docs={docs}
          theme={theme}
          onSelect={doc => { setSelectedDoc(doc); setSearchOpen(false); }}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {newTaskOpen && orgRoot && (
        <NewTaskModal
          theme={theme}
          orgRoot={orgRoot}
          onClose={() => setNewTaskOpen(false)}
          onCreated={() => loadDocs()}
        />
      )}
      <Header theme={theme} view={view} orgRoot={orgRoot} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          theme={theme}
          view={view}
          setView={(v) => {
            setView(v);
            setSelectedDoc(null);
          }}
          terminalOpen={terminalOpen}
          toggleTerminal={() => setTerminalOpen(o => !o)}
          swarmCount={swarmTiles.length}
        />
        <main className="flex-1 overflow-hidden" style={{ position: "relative" }}>
          {/* Regular views — unmount when inactive */}
          <div style={{ display: view === "swarm" ? "none" : "flex", flexDirection: "column", height: "100%" }}>
            {view === "dashboard"  && <DashboardView  {...viewProps} />}
            {view === "tasks"      && <TasksView      {...viewProps} />}
            {view === "knowledge"  && <KnowledgeView  {...viewProps} />}
            {view === "inbox"      && <InboxView      {...viewProps} />}
            {view === "graph"      && <GraphView      {...viewProps} />}
            {view === "code"       && <CodeView       {...viewProps} />}
            {view === "routines"  && <RoutinesView  {...viewProps} />}
            {view === "settings"   && <SettingsView    theme={theme} agentRegistry={agentRegistry} onRegistryChange={handleRegistryChange} />}
          </div>

          {/* Swarm — always mounted so PTY sessions survive view switches */}
          <div style={{
            position: "absolute", inset: 0,
            visibility: view === "swarm" ? "visible" : "hidden",
            pointerEvents: view === "swarm" ? "auto" : "none",
          }}>
            <SwarmView
              theme={theme}
              orgRoot={orgRoot}
              tiles={swarmTiles}
              visible={view === "swarm"}
              focusedSlot={focusedSlot}
              onTileFocus={handleTileFocus}
              onTileClose={handleTileClose}
              onAddShell={handleAddShell}
              onResetLayout={handleResetLayout}
              onTriggerObserver={handleTriggerObserver}
              observerRunning={observerRunning}
              onTilePtyReady={handleTilePtyReady}
              onTileWorkerReady={handleTileWorkerReady}
              agentRegistry={agentRegistry}
              onAddAgent={handleAddAgent}
            />
          </div>
        </main>

        {/* Terminal right sidebar — single instance, width hides/shows it */}
        <div
          style={{
            display: "flex",
            flexShrink: 0,
            width: terminalOpen ? terminalWidth : 0,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "4px",
              flexShrink: 0,
              cursor: "col-resize",
              background: "transparent",
              borderLeft: `1px solid ${theme.border}`,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = theme.accent; }}
            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
            onMouseDown={e => {
              e.preventDefault();
              termDragRef.current = { startX: e.clientX, startWidth: terminalWidth };
              const onMove = (ev: MouseEvent) => {
                if (!termDragRef.current) return;
                const delta = termDragRef.current.startX - ev.clientX;
                const next = Math.max(200, Math.min(window.innerWidth * 0.8, termDragRef.current.startWidth + delta));
                setTerminalWidth(next);
              };
              const onUp = () => {
                termDragRef.current = null;
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          />
          <div style={{ flex: 1, overflow: "hidden", minWidth: 0 }}>
            <TerminalView
              theme={theme}
              orgRoot={orgRoot}
              visible={terminalOpen}
              pendingClaudeTask={null}
              onClaudeTaskHandled={() => {}}
              onRequestOpen={() => setTerminalOpen(true)}
              getSwarmTargets={getSwarmTargets}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
