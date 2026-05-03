// Provider-neutral event model.
// Claude, Codex, Copilot (and any future agent) get normalized into this shape
// so hooks (e.g. maintenance checks) can react to a single `assistant_turn_complete`
// signal regardless of the underlying CLI.

export type ProviderEventType =
  | "session_started"
  | "user_message_submitted"
  | "assistant_turn_started"
  | "assistant_turn_delta"
  | "assistant_turn_complete"
  | "session_ended";

export type SessionEndReason = "user_close" | "process_exit" | "error";

export type ProviderEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "user_message_submitted"; sessionId: string; text: string }
  | { type: "assistant_turn_started"; sessionId: string; turnId: string }
  | { type: "assistant_turn_delta"; sessionId: string; turnId: string; text: string }
  | { type: "assistant_turn_complete"; sessionId: string; turnId: string }
  | { type: "session_ended"; sessionId: string; reason: SessionEndReason };

export type Unsubscribe = () => void;

export interface ProviderSessionState {
  sessionId: string;
  startedAt: number; // Date.now()
  turnCount: number;
  transcriptLines: number;
  lastTurnId: string | null;
  maintenanceRanThisTurn: boolean;
}
