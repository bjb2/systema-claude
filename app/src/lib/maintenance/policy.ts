// Shared maintenance policy — provider-neutral.
// Any agent adapter that emits `assistant_turn_complete` can consult this module
// to decide whether to inject a maintenance check into the running session.

// Mirrors the static signal list in C:\Users\bryan\.claude\hooks\maintenance-check.py
// so non-Claude hosts (codex, etc.) receive the same guidance as Claude's Stop hook.
// Python source is canonical — when signals change there, update this string to match.
// The Python hook also injects dynamic session context (modified files, org stats);
// org-viewer fires mid-session and has no equivalent context to compute, so this
// version is the static subset.
export const MAINTENANCE_PROMPT = `Maintenance vigilance check: evaluate session for capture targets before stopping. If nothing applies, reply exactly "No maintenance needed." and stop.

Signal -> Action:
- New reusable insight/pattern -> knowledge/<subfolder>/<topic>.md AND link from the matching hub (see knowledge/README.md hubs index) so it doesn't land as a sink
- New knowledge article created this session -> verify it's linked from a hub; if no hub fits, the cluster may need a new one
- Project status changed -> update context/current-state.md
- New task identified -> tasks/<name>.md
- Question worth preserving -> queries/<question>.md
- Feature idea / future project -> inbox/ideas/<item>.md
- Decision needed -> inbox/decisions/<item>.md
- Bug to investigate -> inbox/investigations/<item>.md
- Quick unsorted capture -> inbox/captures/<item>.md
- KB file needs organization -> move to appropriate subfolder
- Repeated manual action -> inbox/decisions/<automation-proposal>.md

If ANY signal applies: perform the maintenance NOW.
If NONE apply: reply exactly "No maintenance needed." and stop.

Be aggressive about capture. Lost insights are unrecoverable.`;

export interface MaintenanceThresholds {
  minSessionMinutes?: number;
  minTurnCount?: number;
  minTranscriptLines?: number;
}

export const DEFAULT_THRESHOLDS: MaintenanceThresholds = {
  minSessionMinutes: 5,
  minTurnCount: 2,
  minTranscriptLines: 15,
};
