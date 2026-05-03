import { Theme } from "../themes";
import AgentTile, { TileConfig } from "../components/AgentTile";
import ErrorBoundary from "../components/ErrorBoundary";
import { AgentRegistry, resolveTurnCompleteHooks } from "../lib/agents";

export const MAX_SLOTS = 6;

interface Props {
  theme: Theme;
  orgRoot: string;
  tiles: TileConfig[];
  visible: boolean;
  focusedSlot: number | null;
  onTileFocus: (id: string) => void;
  onTileClose: (id: string) => void;
  onAddShell: () => void;
  onResetLayout: () => void;
  onTriggerObserver?: () => void;
  observerRunning?: boolean;
  onTilePtyReady?: (id: string, ptyId: number) => void;
  onTileWorkerReady?: (id: string, workerId: number) => void;
  agentRegistry?: AgentRegistry | null;
  onAddAgent?: (agentId: string) => void;
}

// Grid template (cols, rows) for a given tile count.
// Slots fill row-by-row in slot order.
function gridTemplate(count: number): { cols: string; rows: string } {
  switch (count) {
    case 1: return { cols: "1fr",         rows: "1fr"       };
    case 2: return { cols: "1fr 1fr",     rows: "1fr"       };
    case 3: return { cols: "1fr 1fr 1fr", rows: "1fr"       };
    case 4: return { cols: "1fr 1fr",     rows: "1fr 1fr"   };
    case 5:
    case 6: return { cols: "1fr 1fr 1fr", rows: "1fr 1fr"   };
    default: return { cols: "1fr",        rows: "1fr"       };
  }
}

export default function SwarmView({
  theme, tiles, visible: _visible, focusedSlot, onTileFocus, onTileClose, onAddShell, onResetLayout,
  onTriggerObserver, observerRunning, onTilePtyReady, onTileWorkerReady,
  agentRegistry, onAddAgent,
}: Props) {
  const turnCompleteHooks = resolveTurnCompleteHooks(agentRegistry ?? null);
  const atCap = tiles.length >= MAX_SLOTS;
  const ordered = [...tiles].sort((a, b) => a.slot - b.slot);
  const tpl = gridTemplate(tiles.length);

  const spawnDisabledStyle = (disabled: boolean): React.CSSProperties => ({
    fontSize: 11,
    color: disabled ? theme.textDim : theme.accent,
    background: disabled ? "transparent" : theme.accentMuted,
    border: `1px solid ${theme.border}`,
    borderRadius: 3,
    padding: "2px 8px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  });

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: theme.bg, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      {/* Toolbar */}
      <div
        style={{
          height: 32,
          flexShrink: 0,
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 12px",
          borderBottom: `1px solid ${theme.border}`,
          background: theme.bgSecondary,
        }}
      >
        <span style={{ fontSize: 11, color: theme.textMuted }}>Swarm</span>
        <span style={{ fontSize: 10, color: atCap ? theme.warning : theme.textDim }}>
          {tiles.length}/{MAX_SLOTS}
        </span>
        <div style={{ flex: 1 }} />
        {tiles.length > 0 && (
          <button
            onClick={onResetLayout}
            style={{
              fontSize: 11,
              color: theme.textDim,
              background: "none",
              border: `1px solid ${theme.border}`,
              borderRadius: 3,
              padding: "2px 8px",
              cursor: "pointer",
            }}
            title="Clear focused-slot promotion (Ctrl+0)"
          >
            reset layout
          </button>
        )}
        {agentRegistry && onAddAgent
          ? Object.entries(agentRegistry.agents).map(([id, cfg]) => (
              <button
                key={id}
                onClick={() => !atCap && onAddAgent(id)}
                disabled={atCap}
                title={atCap ? "Swarm at capacity — kill an agent first" : `Spawn ${cfg.label ?? id}`}
                style={spawnDisabledStyle(atCap)}
              >
                + {cfg.label ?? id}
              </button>
            ))
          : (
              <button
                onClick={() => !atCap && onAddShell()}
                disabled={atCap}
                title={atCap ? "Swarm at capacity — kill an agent first" : "Spawn shell"}
                style={spawnDisabledStyle(atCap)}
              >
                + shell
              </button>
            )
        }
        {onTriggerObserver && (
          <button
            onClick={onTriggerObserver}
            disabled={observerRunning || atCap}
            title={observerRunning ? "Observer already running" : atCap ? "Swarm at capacity" : "Run observer agent"}
            style={spawnDisabledStyle(observerRunning || atCap)}
          >
            ヽ༼ຈل͜ຈ༽ﾉ
          </button>
        )}
      </div>

      {/* Slot grid */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {tiles.length === 0 ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
            }}
          >
            <span style={{ fontSize: 36, opacity: 0.2 }}>ヽ༼ຈل͜ຈ༽ﾉ</span>
            <p style={{ fontSize: 13, color: theme.textDim, margin: 0 }}>no agents running</p>
            <p style={{ fontSize: 11, color: theme.textDim, margin: 0 }}>
              use <span style={{ color: theme.accent }}>❯</span> on a task to spawn one, or{" "}
              <button
                onClick={onAddShell}
                style={{ background: "none", border: "none", color: theme.accent, cursor: "pointer", fontSize: 11, padding: 0 }}
              >
                + shell
              </button>{" "}
              for a blank terminal
            </p>
          </div>
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              gridTemplateColumns: tpl.cols,
              gridTemplateRows: tpl.rows,
              gap: 1,
              background: theme.border,
            }}
          >
            {ordered.map(tile => (
              <div key={tile.id} style={{ minWidth: 0, minHeight: 0, overflow: "hidden", position: "relative" }}>
                <ErrorBoundary label={`tile:${tile.title}`} onClose={() => onTileClose(tile.id)}>
                  <AgentTile
                    tile={tile}
                    theme={theme}
                    focused={focusedSlot === tile.slot}
                    onFocus={onTileFocus}
                    onClose={onTileClose}
                    onPtyReady={onTilePtyReady}
                    onWorkerReady={onTileWorkerReady}
                    turnCompleteHooks={turnCompleteHooks}
                  />
                </ErrorBoundary>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
