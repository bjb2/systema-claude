import { ProviderSessionState } from "../providers/types";
import { MAINTENANCE_PROMPT, MaintenanceThresholds, DEFAULT_THRESHOLDS } from "./policy";

// HookRule is the shape stored in org.config.json under hooks.assistantTurnComplete[].
// The engine itself is pure functions — tile/PTY integration lives in AgentTile.
export interface HookRule {
  enabled?: boolean;
  triggerAgents: string | string[];
  excludeAgents?: string[];
  action: "maintenance-check";
  minSessionMinutes?: number;
  minTurnCount?: number;
  minTranscriptLines?: number;
}

export function shouldRunMaintenance(
  agentId: string,
  state: ProviderSessionState,
  rule: HookRule,
  thresholds: MaintenanceThresholds = DEFAULT_THRESHOLDS,
): boolean {
  if (rule.enabled === false) return false;
  if (state.maintenanceRanThisTurn) return false;

  const agents = rule.triggerAgents;
  if (agents !== "*") {
    const list = Array.isArray(agents) ? agents : [agents];
    if (!list.includes(agentId)) return false;
  }
  if (rule.excludeAgents) {
    if (rule.excludeAgents.includes(agentId)) return false;
  }

  const elapsedMin = (Date.now() - state.startedAt) / 60000;
  const minMin = rule.minSessionMinutes ?? thresholds.minSessionMinutes ?? 0;
  const minTurns = rule.minTurnCount ?? thresholds.minTurnCount ?? 0;
  const minLines = rule.minTranscriptLines ?? thresholds.minTranscriptLines ?? 0;

  return elapsedMin >= minMin && state.turnCount >= minTurns && state.transcriptLines >= minLines;
}

export function buildMaintenancePrompt(_state: ProviderSessionState): string {
  return MAINTENANCE_PROMPT;
}
