import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Theme } from "../themes";
import { useAgentKaomoji } from "../hooks/useAgentKaomoji";
import { HookRule, shouldRunMaintenance, buildMaintenancePrompt } from "../lib/maintenance/engine";
import { ProviderSessionState } from "../lib/providers/types";
import "@xterm/xterm/css/xterm.css";

export interface TileConfig {
  id: string;
  type?: 'agent';
  title: string;
  slot: number;
  taskPath: string | null;
  projectRoot: string;
  promptSuffix?: string;
  promptOverride?: string;
  agentId?: string;
  agentLabel?: string;
  launchCmd?: string;
  launchArgs?: string[];
  submitKey?: "enter" | "shift+enter";
  ptyId?: number;
  workerId?: number;
}

interface Props {
  tile: TileConfig;
  theme: Theme;
  focused: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onPtyReady?: (id: string, ptyId: number) => void;
  onWorkerReady?: (id: string, workerId: number) => void;
  /** Rules evaluated when a provider emits `assistant_turn_complete`. */
  turnCompleteHooks?: HookRule[];
}

// Provider-specific ready-prompt detection.
// Each regex must match on a FRESH line of plain (stripped) PTY output and
// should only match when the agent is idle and waiting for input.
// The ❯ character is Claude's readline indicator; codex uses `> ` and
// copilot falls back to the same pattern. The generic `> ` matcher is
// intentionally loose — the `turnCount` / `transcriptLines` thresholds in
// shouldRunMaintenance() guard against false positives.
const READY_PROMPT_RE: Record<string, RegExp> = {
  // eslint-disable-next-line no-useless-escape
  claude: /^❯\s/m,
  codex: /^[>›]\s/m,
  copilot: /^[>›]\s/m,
  gemini: /^❯\s/m,
};

function readyPromptRegex(agentId: string | undefined): RegExp {
  if (!agentId) return READY_PROMPT_RE.claude;
  return READY_PROMPT_RE[agentId] ?? READY_PROMPT_RE.claude;
}

type TurnPhase = "booting" | "idle" | "awaiting_assistant" | "assistant_active";



export default function AgentTile({ tile, theme, focused, onFocus, onClose, onPtyReady, onWorkerReady, turnCompleteHooks }: Props) {
  const termRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const workerIdRef = useRef<number | null>(null);
  const workerKindRef = useRef<"user" | "maintenance">("user");
  const initRef = useRef(false);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [workerInput, setWorkerInput] = useState("");
  const [workerBusy, setWorkerBusy] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const kaomoji = useAgentKaomoji(!!(tile.taskPath || tile.promptOverride));
  const sendTaskMsgRef = useRef<(() => void) | null>(null);
  const inputBufferRef = useRef("");
  const plainOutputRef = useRef("");
  const turnPhaseRef = useRef<TurnPhase>("booting");

  // Provider-neutral session state for maintenance hooks.
  // Ref (not state) — updated from PTY output without triggering re-renders.
  const sessionStateRef = useRef<ProviderSessionState>({
    sessionId: tile.id,
    startedAt: Date.now(),
    turnCount: 0,
    transcriptLines: 0,
    lastTurnId: null,
    maintenanceRanThisTurn: false,
  });
  // Latest hooks kept in a ref so the long-lived PTY listener always sees the current config
  // without re-running the init effect.
  const hooksRef = useRef<HookRule[]>(turnCompleteHooks ?? []);
  useEffect(() => { hooksRef.current = turnCompleteHooks ?? []; }, [turnCompleteHooks]);
  // Debounces the ready-prompt heuristic — PTY output often contains many consecutive
  // matches while the terminal redraws. We only want to fire once per quiescence.
  const readyPromptSeenRef = useRef(false);
  const readyPromptResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Idle-quiescence turn detection for TUI agents (e.g. Codex) that don't emit a
  // parseable ready prompt. After a user submit, we start a timer and reset it on each
  // multi-line PTY chunk (real response output). Single-line chunks (footer redraws)
  // are ignored. When the timer fires, the turn is complete.
  const quiescenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable callback ref updated each render so the timer closure always sees fresh refs.
  const onQuiescenceRef = useRef<() => void>(() => {});

  // True for agents whose TUI prevents ready-prompt detection.
  const isQuiescenceMode = false;
  const isExecWorkerMode = false;
  const shouldBracketPaste = false;

  const restartWithResume = async () => {
    if (restarting) return;
    setRestarting(true);
    setConfirmRestart(false);
    setSpawnError(null);
    const cmd = tile.launchCmd ?? "claude";
    const cwd = tile.projectRoot || ".";
    const oldPty = ptyIdRef.current;
    const startedAt = sessionStateRef.current.startedAt;

    let sessionId: string | null = null;
    if (cmd === "claude") {
      try {
        sessionId = await invoke<string | null>("find_recent_claude_session", {
          cwd,
          sinceMs: startedAt,
        });
      } catch { sessionId = null; }
    }

    if (oldPty !== null) {
      try { await invoke("pty_kill", { ptyId: oldPty }); } catch {}
      ptyIdRef.current = null;
    }

    const term = terminalRef.current;
    term?.reset();
    const note = cmd === "claude"
      ? (sessionId ? `[restart] resuming ${sessionId.slice(0, 8)}…` : "[restart] no session id found, starting fresh")
      : "[restart] respawning agent";
    term?.write(`\x1b[2m${note}\x1b[0m\r\n`);

    let args: string[];
    if (cmd === "claude") {
      args = sessionId ? ["--resume", sessionId] : ["--continue"];
    } else {
      args = tile.launchArgs ?? [];
    }

    try {
      const newId = await invoke<number>("pty_create", { shell: cmd, args, cwd });
      ptyIdRef.current = newId;
      onPtyReady?.(tile.id, newId);
      turnPhaseRef.current = "booting";
      plainOutputRef.current = "";
      inputBufferRef.current = "";
      sessionStateRef.current.startedAt = Date.now();
      breakReadyQuiescence();
      if (fitRef.current) {
        const dim = fitRef.current.proposeDimensions();
        if (dim) invoke("pty_resize", { ptyId: newId, rows: dim.rows, cols: dim.cols }).catch(() => {});
      }
    } catch (err) {
      setSpawnError(`restart failed: ${err}`);
    } finally {
      setRestarting(false);
    }
  };

  const closeAndKill = () => {
    if (ptyIdRef.current !== null) {
      invoke("pty_kill", { ptyId: ptyIdRef.current }).catch(() => {});
      ptyIdRef.current = null;
    }
    if (workerIdRef.current !== null) {
      invoke("worker_kill", { workerId: workerIdRef.current }).catch(() => {});
      workerIdRef.current = null;
    }
    onClose(tile.id);
  };

  const injectPrompt = (ptyId: number, text: string) => {
    const data = shouldBracketPaste ? `\x1b[200~${text}\x1b[201~` : text;
    const submitDelayMs = shouldBracketPaste ? 120 : 250;
    return invoke("pty_write", { ptyId, data })
      .then(() => new Promise(resolve => setTimeout(resolve, submitDelayMs)))
      .then(() => invoke("pty_write", { ptyId, data: "\r\n" }));
  };

  const runWorkerMaintenance = () => {
    const st = sessionStateRef.current;
    const agentId = tile.agentId ?? "claude";
    for (const rule of hooksRef.current) {
      if (rule.action !== "maintenance-check") continue;
      if (shouldRunMaintenance(agentId, st, rule, { minTranscriptLines: 0 })) {
        st.maintenanceRanThisTurn = true;
        workerKindRef.current = "maintenance";
        const prompt = buildMaintenancePrompt(st);
        setWorkerBusy(true);
        terminalRef.current?.write(`\r\n\x1b[2m[maintenance]\x1b[0m\r\n`);
        invoke<number>("worker_start", {
          command: "codex",
          args: ["exec", "--color", "never", "--skip-git-repo-check", "-"],
          cwd: tile.projectRoot,
          stdin: prompt,
        }).then(id => {
          workerIdRef.current = id;
          onWorkerReady?.(tile.id, id);
        }).catch(err => {
          setWorkerBusy(false);
          workerKindRef.current = "user";
          setSpawnError(String(err));
        });
        return true;
      }
    }
    return false;
  };

  const submitWorkerPrompt = (text: string, kind: "user" | "maintenance" = "user") => {
    const prompt = text.trim();
    if (!prompt || workerBusy) return;
    setSpawnError(null);
    setWorkerBusy(true);
    workerKindRef.current = kind;
    turnPhaseRef.current = "assistant_active";
    if (kind === "user") {
      terminalRef.current?.write(`\r\n\x1b[36m> ${prompt}\x1b[0m\r\n\r\n`);
      setWorkerInput("");
    } else {
      terminalRef.current?.write(`\r\n\x1b[2m[maintenance]\x1b[0m\r\n`);
    }
    invoke<number>("worker_start", {
      command: "codex",
      args: ["exec", "--color", "never", "--skip-git-repo-check", "-"],
      cwd: tile.projectRoot,
      stdin: prompt,
    }).then(id => {
      workerIdRef.current = id;
      onWorkerReady?.(tile.id, id);
    }).catch(err => {
      setWorkerBusy(false);
      workerKindRef.current = "user";
      setSpawnError(String(err));
    });
  };

  onQuiescenceRef.current = () => {
    quiescenceTimerRef.current = null;
    if (turnPhaseRef.current === "booting" || turnPhaseRef.current === "idle") return;
    turnPhaseRef.current = "idle";
    const st = sessionStateRef.current;
    st.turnCount += 1;
    st.lastTurnId = `${tile.id}-t${st.turnCount}`;
    const agentId = tile.agentId ?? "claude";
    for (const rule of hooksRef.current) {
      if (rule.action !== "maintenance-check") continue;
      // Pass minTranscriptLines:0 — TUI output has no newlines, so the default
      // threshold of 15 would never be satisfied for Codex.
      if (shouldRunMaintenance(agentId, st, rule, { minTranscriptLines: 0 })) {
        st.maintenanceRanThisTurn = true;
        const pid = ptyIdRef.current;
        if (pid !== null) {
          const prompt = buildMaintenancePrompt(st);
          injectPrompt(pid, prompt).catch(() => {});
        }
        break;
      }
    }
    setTimeout(() => { sessionStateRef.current.maintenanceRanThisTurn = false; }, 2000);
  };

  const startQuiescenceTimer = (ms: number) => {
    if (quiescenceTimerRef.current) clearTimeout(quiescenceTimerRef.current);
    quiescenceTimerRef.current = setTimeout(() => onQuiescenceRef.current(), ms);
  };

  const breakReadyQuiescence = () => {
    if (readyPromptResetTimerRef.current) {
      clearTimeout(readyPromptResetTimerRef.current);
      readyPromptResetTimerRef.current = null;
    }
    readyPromptSeenRef.current = false;
  };

  const markUserSubmitted = () => {
    if (turnPhaseRef.current === "booting") return;
    turnPhaseRef.current = "awaiting_assistant";
    plainOutputRef.current = "";
    breakReadyQuiescence();
    // For TUI agents: start a 5s fallback timer immediately. The PTY listener will
    // reset it to 3s once active multi-line output is seen.
    if (isQuiescenceMode) startQuiescenceTimer(5000);
  };

  const consumeUserInput = (data: string) => {
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        const submitted = inputBufferRef.current.trim();
        inputBufferRef.current = "";
        if (submitted.length > 0 || turnPhaseRef.current !== "booting") {
          markUserSubmitted();
        }
        continue;
      }
      if (ch === "" || ch === "\b") {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1);
        continue;
      }
      if (ch >= " ") {
        inputBufferRef.current += ch;
      }
    }
  };

  // Terminal init + PTY spawn
  useEffect(() => {
    if (!termRef.current || initRef.current) return;
    initRef.current = true;

    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: "block",
      fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.0,
      letterSpacing: 0,
      allowProposedApi: true,
      scrollback: 5000,
      minimumContrastRatio: 1,
      theme: {
        background: theme.bg,
        foreground: theme.text,
        // Inner TUIs (claude/codex/gemini) paint their own block cursor into the
        // buffer; xterm's cursor on top causes a visible double-cursor. Match it
        // to the background so only the agent's cursor is visible.
        cursor: theme.bg,
        cursorAccent: theme.bg,
        selectionBackground: theme.accentMuted,
        selectionForeground: theme.text,
        black: "#1a1a2e", red: theme.error, green: theme.success,
        yellow: theme.warning, blue: "#4a8cf0", magenta: "#c84af0",
        cyan: "#4ac8f0", white: "#d0d0e8",
        brightBlack: theme.textDim, brightRed: "#ff7060", brightGreen: "#6eff90",
        brightYellow: "#ffe060", brightBlue: "#7aaaf8", brightMagenta: "#e07af8",
        brightCyan: "#7ae8f8", brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fitAddon);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    term.parser.registerOscHandler(7,   () => true);
    term.parser.registerOscHandler(133, () => true);
    term.parser.registerOscHandler(633, () => true);

    term.open(termRef.current);
    // Prevent xterm's native paste-event handler from doubling our Ctrl+V paste.
    // Must use capture phase so this fires before xterm's textarea handler (inner elements fire first in bubble).
    // stopPropagation prevents the event from reaching the textarea entirely.
    term.element?.addEventListener('paste', (e) => { e.preventDefault(); e.stopPropagation(); }, { capture: true });

    // Ctrl+C with selection → copy to clipboard (don't send SIGINT).
    // Ctrl+V → paste from clipboard into PTY (don't send \x16).
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.shiftKey || e.altKey) return true;
      if (e.key === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (e.key === 'v') {
        navigator.clipboard.readText().then(text => { if (text) term.paste(text); }).catch(() => {});
        return false;
      }
      return true;
    });

    let webgl: WebglAddon | null = null;
    // Codex redraws a sticky footer very frequently; canvas renderer is more stable
    // than WebGL for that workload in embedded ConPTY terminals.
    if (tile.agentId !== "codex") {
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => { try { webgl?.dispose(); } catch {} webgl = null; });
        term.loadAddon(webgl);
      } catch { webgl = null; }
    }

    fitAddon.fit();
    terminalRef.current = term;
    fitRef.current = fitAddon;

    if (isExecWorkerMode) {
      term.write("\x1b[2mCodex worker ready. Submit a prompt below.\x1b[0m\r\n");
      turnPhaseRef.current = "idle";
      if (tile.workerId) {
        workerIdRef.current = tile.workerId;
        onWorkerReady?.(tile.id, tile.workerId);
        invoke<string>("worker_buffer", { workerId: tile.workerId })
          .then(buffer => { if (buffer) term.write(buffer); })
          .catch(() => {});
        invoke<boolean>("worker_is_running", { workerId: tile.workerId })
          .then(running => setWorkerBusy(running))
          .catch(() => setWorkerBusy(false));
      } else if (tile.promptOverride || tile.taskPath) {
        const text = tile.promptOverride
          ?? `Read ${tile.taskPath} for your task. Project context is in ${tile.projectRoot}/CLAUDE.md. Begin working immediately.${tile.promptSuffix ? `\n\nAdditional context from user:\n${tile.promptSuffix}` : ""}`;
        setTimeout(() => submitWorkerPrompt(text), 120);
      }
      return () => {
        initRef.current = false;
        terminalRef.current = null;
        fitRef.current = null;
        // UI unmount is detach-only. Explicit tile close owns process cleanup.
        setWorkerBusy(false);
        inputBufferRef.current = "";
        plainOutputRef.current = "";
        turnPhaseRef.current = "booting";
        try { webgl?.dispose(); } catch {}
        webgl = null;
        try { term.dispose(); } catch {}
      };
    }

    const cwd = tile.projectRoot || ".";

    if (tile.ptyId) {
      const id = tile.ptyId;
      ptyIdRef.current = id;
      onPtyReady?.(tile.id, id);
      invoke<string>("pty_buffer", { ptyId: id })
        .then(buffer => { if (buffer) term.write(buffer); })
        .catch(() => {});
      const dim = fitAddon.proposeDimensions();
      if (dim) invoke("pty_resize", { ptyId: id, rows: dim.rows, cols: dim.cols }).catch(() => {});
      term.onData(data => {
        const pid = ptyIdRef.current;
        if (pid === null) return;
        consumeUserInput(data);
        invoke("pty_write", { ptyId: pid, data }).catch(() => {});
      });
      turnPhaseRef.current = "idle";
    } else {
      // Spawn the agent CLI as the PTY child directly. orgd resolves PATHEXT
      // (so "claude" → "...\claude.cmd" is found) and portable_pty + cmd.exe
      // handle .cmd invocation. No powershell wrapper — one process per tile
      // instead of two, matching the experience of running claude in Windows
      // Terminal.
      const cmd = tile.launchCmd ?? "claude";
      const args = tile.launchArgs ?? [];
      invoke<number>("pty_create", { shell: cmd, args, cwd })
      .then(id => {
        ptyIdRef.current = id;
        onPtyReady?.(tile.id, id);
        const dim = fitAddon.proposeDimensions();
        if (dim) invoke("pty_resize", { ptyId: id, rows: dim.rows, cols: dim.cols }).catch(() => {});

        term.onData(data => {
          const pid = ptyIdRef.current;
          if (pid === null) return;
          consumeUserInput(data);
          invoke("pty_write", { ptyId: pid, data }).catch(() => {});
        });

        if (tile.promptOverride || tile.taskPath) {
          const sendTaskMsg = () => {
            if (turnPhaseRef.current !== "booting") return;
            turnPhaseRef.current = "awaiting_assistant";
            plainOutputRef.current = "";
            breakReadyQuiescence();
            const text = tile.promptOverride
              ?? `Read ${tile.taskPath} for your task. Project context is in ${tile.projectRoot}/CLAUDE.md. Begin working immediately.${tile.promptSuffix ? `\n\nAdditional context from user:\n${tile.promptSuffix}` : ""}`;
            injectPrompt(id, text).catch(() => {});
          };
          sendTaskMsgRef.current = sendTaskMsg;
          // 15s fallback — fires if the ready-indicator watch below misses the prompt
          setTimeout(sendTaskMsg, 15000);
        }
      })
      .catch(err => {
        console.error("AgentTile spawn error:", err);
        setSpawnError(String(err));
        term.write(`\r\n\x1b[31mFailed to start process:\x1b[0m ${err}\r\n`);
      });
    }

    return () => {
      initRef.current = false;
      terminalRef.current = null;
      fitRef.current = null;
      if (readyPromptResetTimerRef.current) {
        clearTimeout(readyPromptResetTimerRef.current);
        readyPromptResetTimerRef.current = null;
      }
      if (quiescenceTimerRef.current) {
        clearTimeout(quiescenceTimerRef.current);
        quiescenceTimerRef.current = null;
      }
      inputBufferRef.current = "";
      plainOutputRef.current = "";
      turnPhaseRef.current = "booting";
      // UI unmount is detach-only. Explicit tile close owns process cleanup.
      try { webgl?.dispose(); } catch {}
      webgl = null;
      try { term.dispose(); } catch {}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PTY output → xterm renderer + permission prompt logging
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    let unlistenLag: (() => void) | undefined;
    // eslint-disable-next-line no-control-regex
    const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;

    // orgd's WS broadcast can drop frames if a subscriber lags behind the
    // tokio broadcast channel capacity. The pump in orgd_client.rs emits
    // `orgd-lag` to the webview when that happens. Resync by refetching
    // the authoritative buffer from orgd and replaying it to the terminal.
    listen<unknown>("orgd-lag", () => {
      const term = terminalRef.current;
      if (!term) return;
      const refetch = isExecWorkerMode
        ? (workerIdRef.current !== null
            ? invoke<string>("worker_buffer", { workerId: workerIdRef.current })
            : null)
        : (ptyIdRef.current !== null
            ? invoke<string>("pty_buffer", { ptyId: ptyIdRef.current })
            : null);
      if (!refetch) return;
      refetch
        .then(buffer => {
          // Reset clears the screen and scrollback; rewriting the full
          // buffer leaves the terminal in a known-good state matching
          // orgd's ring. Cheaper than diffing missed-vs-seen output.
          term.reset();
          if (buffer) term.write(buffer);
        })
        .catch(() => {});
    }).then(fn => {
      if (cancelled) fn(); else unlistenLag = fn;
    });

    if (isExecWorkerMode) {
      listen<{ worker_id: number; data: string; stream: "stdout" | "stderr" }>("worker-output", ({ payload }) => {
        if (payload.worker_id !== workerIdRef.current) return;
        terminalRef.current?.write(payload.data);
        const plain = payload.data.replace(ANSI_RE, "");
        if (plain.length > 0) {
          plainOutputRef.current = (plainOutputRef.current + plain).slice(-8000);
          const newlines = (plain.match(/\n/g) || []).length;
          if (newlines > 0) sessionStateRef.current.transcriptLines += newlines;
        }
      }).then(fn => {
        if (cancelled) fn(); else unlisten = fn;
      });
      listen<{ worker_id: number; code: number | null; success: boolean }>("worker-exit", ({ payload }) => {
        if (payload.worker_id !== workerIdRef.current) return;
        workerIdRef.current = null;
        setWorkerBusy(false);
        turnPhaseRef.current = "idle";
        terminalRef.current?.write(`\r\n\x1b[2m[exit ${payload.code ?? "?"}]\x1b[0m\r\n`);
        if (workerKindRef.current === "maintenance") {
          workerKindRef.current = "user";
          sessionStateRef.current.maintenanceRanThisTurn = false;
          return;
        }
        const st = sessionStateRef.current;
        st.turnCount += 1;
        st.lastTurnId = `${tile.id}-t${st.turnCount}`;
        runWorkerMaintenance();
      }).then(fn => {
        if (cancelled) fn(); else unlistenExit = fn;
      });
      return () => {
        cancelled = true;
        unlisten?.();
        unlistenExit?.();
        unlistenLag?.();
      };
    }
    listen<{ pty_id: number; data: string }>("pty-output", ({ payload }) => {
      if (payload.pty_id !== ptyIdRef.current) return;
      // Codex redraws a sticky footer via ESC[s…ESC[u (also ESC 7/8 variants).
      // xterm renders each intermediate frame, making the cursor visibly jump to
      // the footer row. Injecting DECTCEM hide/show around those sequences makes
      // the jump invisible without affecting normal cursor behavior.
      const displayData = tile.agentId === "codex"
        ? payload.data
            .replace(/\x1b\[s|\x1b7/g, (m) => m + "\x1b[?25l")
            .replace(/\x1b\[u|\x1b8/g, (m) => "\x1b[?25h" + m)
        : payload.data;
      terminalRef.current?.write(displayData);
      const plain = payload.data.replace(ANSI_RE, "");
      if (plain.length > 0) {
        plainOutputRef.current = (plainOutputRef.current + plain).slice(-8000);
      }

      // Track transcript volume for maintenance threshold gating.
      if (plain.length > 0) {
        const newlines = (plain.match(/\n/g) || []).length;
        if (newlines > 0) {
          sessionStateRef.current.transcriptLines += newlines;
        }
      }

      const readyRe = readyPromptRegex(tile.agentId);
      const readyHit =
        readyRe.test(plainOutputRef.current) ||
        /(?:^|[\r\n])[>›❯][ \t]/.test(plainOutputRef.current);

      // Detect Claude Code's ready prompt (❯ at line start) and fire task message immediately.
      // Do NOT match ◆ — it appears in the loading banner before readline is active, causing
      // the message to be sent too early and flushed/discarded during startup.
      if (sendTaskMsgRef.current && turnPhaseRef.current === "booting" && readyHit) {
        sendTaskMsgRef.current();
      }

      // The first ready prompt only means the provider finished booting.
      if (readyHit && turnPhaseRef.current === "booting") {
        turnPhaseRef.current = "idle";
      }

      // Provider-neutral `assistant_turn_complete` emission.
      // Firing rule: ready prompt observed after a real user submit in this session
      // and we haven't already counted a turn-complete during this quiescent window.
      if (readyHit && turnPhaseRef.current !== "booting" && turnPhaseRef.current !== "idle") {
        if (!readyPromptSeenRef.current) {
          readyPromptSeenRef.current = true;
          turnPhaseRef.current = "idle";
          const st = sessionStateRef.current;
          st.turnCount += 1;
          st.lastTurnId = `${tile.id}-t${st.turnCount}`;

          // Evaluate hooks — first matching rule wins.
          const agentId = tile.agentId ?? "claude";
          for (const rule of hooksRef.current) {
            if (rule.action !== "maintenance-check") continue;
            if (shouldRunMaintenance(agentId, st, rule)) {
              st.maintenanceRanThisTurn = true;
              const pid = ptyIdRef.current;
              if (pid !== null) {
                const prompt = buildMaintenancePrompt(st);
                injectPrompt(pid, prompt).catch(() => {});
              }
              break;
            }
          }
        }

        // Reset the quiescence flag once the prompt quiets down.
        // Any subsequent PTY output (user typing, model replying) will clear it,
        // so the next quiescent return to the prompt emits a fresh turn-complete.
        if (readyPromptResetTimerRef.current) clearTimeout(readyPromptResetTimerRef.current);
        readyPromptResetTimerRef.current = setTimeout(() => {
          readyPromptSeenRef.current = false;
          // New turn boundary on next ready → clear the maintenance flag for re-evaluation.
          sessionStateRef.current.maintenanceRanThisTurn = false;
        }, 2000);
      } else if (plain.includes("\n")) {
        // Non-ready multi-line output means the agent is actively producing a response —
        // cancel the reset timer and break the quiescent window so the next ready prompt
        // counts as a fresh turn. Single-line chunks (e.g. Codex's sticky status-bar
        // redraws: "gpt-5.4 default · ~/enclave/my-org") are intentionally ignored here
        // so they don't perpetually reset the timer and prevent maintenance from firing.
        if (turnPhaseRef.current === "awaiting_assistant") {
          turnPhaseRef.current = "assistant_active";
        }
        breakReadyQuiescence();
        // For TUI agents: each real response chunk resets the quiescence timer to 3s.
        // Check assistant_active only — awaiting_assistant just transitioned above.
        // Footer redraws (single-line, no \n) fall through without touching this timer.
        if (isQuiescenceMode && turnPhaseRef.current === "assistant_active") {
          startQuiescenceTimer(3000);
        }
      }

      if (/Allow\b/.test(plain) && /\?/.test(plain)) {
        for (const line of plain.split("\n")) {
          const trimmed = line.trim();
          if (/Allow\b/.test(trimmed) && /\?/.test(trimmed)) {
            invoke("append_permission_log", {
              entry: JSON.stringify({
                timestamp: new Date().toISOString(),
                agent: tile.title,
                line: trimmed.slice(0, 300),
              }),
            }).catch(() => {});
          }
        }
      }
    }).then(fn => {
      if (cancelled) fn(); else unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); unlistenExit?.(); unlistenLag?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refit on container resize (grid layout changes when slot count changes,
  // when window resizes, or when this slot is promoted/demoted).
  useEffect(() => {
    const el = termRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(async () => {
        if (!fitRef.current) return;
        if (isExecWorkerMode) {
          fitRef.current.fit();
        } else if (ptyIdRef.current !== null) {
          // Reverse the resize order: tell the PTY about the new dimensions
          // and wait for ack before resizing xterm's grid. Otherwise the
          // shell keeps emitting at the old width while xterm has already
          // flipped to the new width, producing the overlapping/garbled
          // text seen on window resize. See [[org-viewer-terminal-resize-corruption]].
          const dim = fitRef.current.proposeDimensions();
          if (dim) {
            try {
              await invoke("pty_resize", { ptyId: ptyIdRef.current, rows: dim.rows, cols: dim.cols });
            } catch {}
          }
          fitRef.current?.fit();
        }
      }, 60);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
    };
  }, [isExecWorkerMode]);

  const hasPrompt = !!(tile.taskPath || tile.promptOverride);
  const titleBarBg = hasPrompt ? theme.accentMuted : theme.bgTertiary;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: theme.bg,
        borderLeft: `1px solid ${focused ? theme.accent : "transparent"}`,
        opacity: focused ? 1 : 0.92,
        overflow: "hidden",
        minWidth: 0,
        minHeight: 0,
      }}
      onMouseDown={() => onFocus(tile.id)}
    >
      {/* Header strip — 24px */}
      <div
        style={{
          height: 24,
          flexShrink: 0,
          background: titleBarBg,
          borderBottom: `1px solid ${theme.border}`,
          padding: "0 8px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          userSelect: "none",
        }}
      >
        <span style={{
          fontSize: hasPrompt ? 13 : 10,
          color: hasPrompt ? theme.accent : theme.textDim,
          flexShrink: 0,
          lineHeight: 1,
          transition: "opacity 0.3s",
        }}>
          {hasPrompt ? kaomoji : "❯_"}
        </span>
        <span style={{
          flex: 1, fontSize: 11, color: theme.text,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {tile.title}
        </span>
        {tile.agentLabel && (
          <span style={{
            fontSize: 9, color: theme.textDim, background: theme.bgTertiary,
            border: `1px solid ${theme.border}`, borderRadius: 3,
            padding: "1px 4px", flexShrink: 0, letterSpacing: "0.03em",
          }}>
            [{tile.agentLabel}]
          </span>
        )}
        {!isExecWorkerMode && (
          confirmRestart ? (
            <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: theme.textDim }}>
              <span>restart?</span>
              <button
                style={{ fontSize: 11, color: theme.success, background: "none", border: "none", cursor: "pointer", padding: "0 3px", lineHeight: 1 }}
                onMouseDown={e => e.stopPropagation()}
                onClick={restartWithResume}
                title="Confirm restart"
              >
                ✓
              </button>
              <button
                style={{ fontSize: 11, color: theme.error, background: "none", border: "none", cursor: "pointer", padding: "0 3px", lineHeight: 1 }}
                onMouseDown={e => e.stopPropagation()}
                onClick={() => setConfirmRestart(false)}
                title="Cancel"
              >
                ✕
              </button>
            </span>
          ) : (
            <button
              style={{ fontSize: 12, color: theme.text, background: "none", border: "none", cursor: restarting ? "wait" : "pointer", padding: "0 4px", lineHeight: 1, opacity: restarting ? 0.4 : 0.7 }}
              onMouseDown={e => e.stopPropagation()}
              onClick={() => setConfirmRestart(true)}
              disabled={restarting}
              title="Restart agent (kill PTY + claude --resume)"
            >
              ↻
            </button>
          )
        )}
        <button
          style={{ fontSize: 12, color: theme.text, background: "none", border: "none", cursor: "pointer", padding: "0 4px", lineHeight: 1, opacity: 0.7 }}
          onMouseDown={e => e.stopPropagation()}
          onClick={closeAndKill}
          title="Kill agent"
        >
          ✕
        </button>
      </div>

      {/* Error banner */}
      {spawnError && (
        <div style={{
          padding: "6px 10px", fontSize: 11, color: theme.error,
          background: theme.bgSecondary, borderBottom: `1px solid ${theme.border}`,
          flexShrink: 0, wordBreak: "break-all",
        }}>
          <strong>Spawn error:</strong> {spawnError}
        </div>
      )}

      {/* Terminal */}
      <div ref={termRef} style={{ flex: 1, background: theme.bg, overflow: "hidden", minHeight: 0 }} />

      {isExecWorkerMode && (
        <div style={{
          padding: 8,
          borderTop: `1px solid ${theme.border}`,
          background: theme.bgSecondary,
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
        }}>
          <textarea
            value={workerInput}
            disabled={workerBusy}
            onChange={e => setWorkerInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitWorkerPrompt(workerInput);
              }
            }}
            placeholder={workerBusy ? "Codex is running..." : "Send prompt to Codex exec"}
            style={{
              flex: 1,
              minHeight: 34,
              maxHeight: 110,
              resize: "vertical",
              background: theme.bg,
              color: theme.text,
              border: `1px solid ${theme.border}`,
              borderRadius: 4,
              padding: "7px 9px",
              fontSize: 12,
              fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
            }}
          />
          <button
            onClick={() => submitWorkerPrompt(workerInput)}
            disabled={workerBusy || workerInput.trim().length === 0}
            style={{
              height: 34,
              padding: "0 12px",
              borderRadius: 4,
              border: `1px solid ${theme.border}`,
              background: workerBusy ? theme.bgTertiary : theme.accentMuted,
              color: workerBusy ? theme.textDim : theme.accent,
              cursor: workerBusy ? "not-allowed" : "pointer",
              fontSize: 11,
            }}
          >
            {workerBusy ? "running" : "run"}
          </button>
        </div>
      )}
    </div>
  );
}
