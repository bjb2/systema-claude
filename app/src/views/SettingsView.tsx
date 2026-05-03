import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Theme } from "../themes";
import { AgentRegistry } from "../lib/agents";

interface Props {
  theme: Theme;
  agentRegistry: AgentRegistry | null;
  onRegistryChange: (registry: AgentRegistry) => void;
}

export default function SettingsView({ theme, agentRegistry, onRegistryChange }: Props) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agents = agentRegistry ? Object.keys(agentRegistry.agents) : ["claude"];
  const currentDefault = agentRegistry?.defaultAgent ?? "claude";

  const setDefault = useCallback(async (agentId: string) => {
    if (!agentRegistry) return;
    const updated: AgentRegistry = { ...agentRegistry, defaultAgent: agentId };
    setSaving(true);
    setError(null);
    try {
      await invoke("write_org_config", { content: JSON.stringify(updated, null, 2) });
      onRegistryChange(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [agentRegistry, onRegistryChange]);

  const row = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    borderRadius: 6,
    marginBottom: 6,
    border: `1px solid ${theme.border}`,
    background: theme.bgTertiary,
  } as React.CSSProperties;

  return (
    <div
      className="flex flex-col h-full overflow-y-auto"
      style={{ background: theme.bg, padding: 32 }}
    >
      <div style={{ maxWidth: 520 }}>
        <h2
          className="font-semibold tracking-wide mb-1"
          style={{ color: theme.text, fontSize: 16 }}
        >
          Settings
        </h2>
        <p className="mb-6 text-sm" style={{ color: theme.textMuted }}>
          Workspace configuration sourced from <code style={{ color: theme.accent }}>org.config.json</code>
        </p>

        {/* Default Agent */}
        <section className="mb-8">
          <h3
            className="text-xs font-semibold tracking-widest uppercase mb-3"
            style={{ color: theme.textMuted }}
          >
            Default Agent
          </h3>

          {!agentRegistry && (
            <p className="text-sm" style={{ color: theme.textMuted }}>
              No <code style={{ color: theme.accent }}>org.config.json</code> found at org root.
              Create one to register agents.
            </p>
          )}

          {agentRegistry && agents.map(id => {
            const cfg = agentRegistry.agents[id];
            const isDefault = id === currentDefault;
            return (
              <div key={id} style={row}>
                <div style={{ flex: 1 }}>
                  <div
                    className="font-medium text-sm"
                    style={{ color: theme.text }}
                  >
                    {cfg.label ?? id}
                  </div>
                  <div
                    className="text-xs font-mono mt-0.5"
                    style={{ color: theme.textDim }}
                  >
                    {cfg.launchCmd}
                  </div>
                </div>
                <button
                  onClick={() => !isDefault && setDefault(id)}
                  disabled={isDefault || saving}
                  style={{
                    padding: "4px 12px",
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: isDefault ? "default" : "pointer",
                    background: isDefault ? theme.accentMuted : theme.bgSecondary,
                    color: isDefault ? theme.accent : theme.textMuted,
                    border: `1px solid ${isDefault ? theme.accent : theme.border}`,
                    opacity: saving ? 0.6 : 1,
                    transition: "all 0.15s",
                  }}
                >
                  {isDefault ? (saved ? "Saved ✓" : "Default") : "Set default"}
                </button>
              </div>
            );
          })}

          {error && (
            <p className="text-xs mt-2" style={{ color: theme.error }}>{error}</p>
          )}
        </section>

        {/* Registered agent details */}
        {agentRegistry && (
          <section>
            <h3
              className="text-xs font-semibold tracking-widest uppercase mb-3"
              style={{ color: theme.textMuted }}
            >
              Registered Agents
            </h3>
            <div
              className="text-xs font-mono p-4 rounded"
              style={{
                background: theme.bgSecondary,
                border: `1px solid ${theme.border}`,
                color: theme.textMuted,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {JSON.stringify(agentRegistry, null, 2)}
            </div>
            <p className="text-xs mt-2" style={{ color: theme.textDim }}>
              Edit <code style={{ color: theme.accent }}>org.config.json</code> in the Code view to add or modify agents.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
