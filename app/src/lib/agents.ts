import type { HookRule } from "./maintenance/engine";

export interface AgentConfig {
  id: string;
  label: string;
  launchCmd: string;
  launchArgs?: string[];
  printArgs: string[];
  promptQuote: "single" | "double";
  submitKey?: "enter" | "shift+enter";
  /** Optional priming message auto-sent on first ready prompt when the tile has no task. */
  primer?: string;
}

export const DEFAULT_PRIMER = "read libraries/shared/orientation.md in the shared library. let me know when you are ready.";

export interface AgentHooks {
  /** Rules evaluated when a provider emits `assistant_turn_complete`. */
  assistantTurnComplete?: HookRule[];
}

export interface AgentRegistry {
  defaultAgent: string;
  agents: Record<string, Omit<AgentConfig, "id">>;
  hooks?: AgentHooks;
}

export const CLAUDE_FALLBACK: AgentConfig = {
  id: "claude",
  label: "Claude",
  launchCmd: "claude",
  launchArgs: [],
  printArgs: ["--print"],
  promptQuote: "single",
};

export function resolveAgent(agentId: string | undefined, registry: AgentRegistry | null): AgentConfig {
  const id = agentId ?? registry?.defaultAgent ?? "claude";
  const entry = registry?.agents[id];
  if (!entry) return { ...CLAUDE_FALLBACK, id };
  return {
    id,
    ...entry,
    launchArgs: entry.launchArgs ?? (id === "codex" ? ["--no-alt-screen"] : []),
  };
}

/**
 * Extract the `assistantTurnComplete` hook rules for a given agent.
 * Returns an empty array when the registry has no hooks configured.
 */
export function resolveTurnCompleteHooks(registry: AgentRegistry | null): HookRule[] {
  return registry?.hooks?.assistantTurnComplete ?? [];
}
