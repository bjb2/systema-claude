import { useState, useEffect, useRef } from "react";
import { Theme, ViewKey } from "../themes";

interface NavItem {
  key: ViewKey;
  label: string;
  shortcut: string;
  icon: string;
}

const NAV: NavItem[] = [
  { key: "dashboard",  label: "Dashboard",  shortcut: "1", icon: "▣" },
  { key: "tasks",      label: "Tasks",      shortcut: "2", icon: "✓" },
  { key: "knowledge",  label: "Knowledge",  shortcut: "3", icon: "◈" },
  { key: "inbox",      label: "Inbox",      shortcut: "4", icon: "◎" },
  { key: "graph",      label: "Graph",      shortcut: "5", icon: "◉" },
  { key: "code",       label: "Code",       shortcut: "6", icon: "⟨⟩" },
  { key: "swarm",      label: "Swarm",      shortcut: "0", icon: "⊞" },
  { key: "routines",   label: "Routines",   shortcut: "8", icon: "⏱" },
  { key: "settings",   label: "Settings",   shortcut: "s", icon: "⚙" },
];

const WORK_SECS = 25 * 60;
const BREAK_SECS = 5 * 60;

function PomodoroTimer({ theme }: { theme: Theme }) {
  const [mode, setMode] = useState<"work" | "break">("work");
  const [seconds, setSeconds] = useState(WORK_SECS);
  const [running, setRunning] = useState(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Tick
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSeconds(s => s - 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Switch mode at zero
  useEffect(() => {
    if (seconds > 0) return;
    setRunning(false);
    const next = modeRef.current === "work" ? "break" : "work";
    setMode(next);
    setSeconds(next === "break" ? BREAK_SECS : WORK_SECS);
  }, [seconds]);

  const total = mode === "work" ? WORK_SECS : BREAK_SECS;
  const progress = seconds / total;
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = (seconds % 60).toString().padStart(2, "0");

  const r = 22;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - progress);
  const modeColor = mode === "work" ? theme.accent : theme.success;

  const reset = () => {
    setRunning(false);
    setMode("work");
    setSeconds(WORK_SECS);
  };

  return (
    <div
      className="px-3 pt-2 pb-3 flex flex-col items-center gap-1.5"
      style={{ borderTop: `1px solid ${theme.border}` }}
    >
      {/* Ring + time */}
      <div className="relative flex items-center justify-center" style={{ width: 56, height: 56 }}>
        <svg width={56} height={56} style={{ position: "absolute", transform: "rotate(-90deg)" }}>
          <circle cx={28} cy={28} r={r} fill="none" stroke={theme.bgTertiary} strokeWidth={2.5} />
          <circle
            cx={28} cy={28} r={r}
            fill="none"
            stroke={modeColor}
            strokeWidth={2.5}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            style={{ transition: running ? "stroke-dashoffset 0.8s linear" : "none" }}
          />
        </svg>
        <div style={{ position: "relative", zIndex: 1, textAlign: "center" }}>
          <div
            className="font-mono font-semibold"
            style={{ color: theme.text, fontSize: 11, letterSpacing: "0.05em", lineHeight: 1 }}
          >
            {mins}:{secs}
          </div>
        </div>
      </div>

      {/* Mode label */}
      <div
        className="font-medium tracking-widest"
        style={{ color: modeColor, fontSize: 8, opacity: 0.9 }}
      >
        {mode === "work" ? "FOCUS" : "BREAK"}
      </div>

      {/* Controls */}
      <div className="flex gap-1.5">
        <button
          onClick={() => setRunning(r => !r)}
          className="flex items-center justify-center rounded transition-colors"
          style={{
            width: 28, height: 22, fontSize: 10,
            background: running ? theme.accentMuted : theme.bgTertiary,
            color: running ? theme.accent : theme.textMuted,
            border: `1px solid ${running ? theme.accent : theme.border}`,
          }}
          title={running ? "Pause" : "Start"}
        >
          {running ? "⏸" : "▶"}
        </button>
        <button
          onClick={reset}
          className="flex items-center justify-center rounded transition-colors"
          style={{
            width: 28, height: 22, fontSize: 12,
            background: theme.bgTertiary,
            color: theme.textMuted,
            border: `1px solid ${theme.border}`,
          }}
          title="Reset"
        >
          ↺
        </button>
      </div>
    </div>
  );
}

interface Props {
  theme: Theme;
  view: ViewKey;
  setView: (v: ViewKey) => void;
  terminalOpen: boolean;
  toggleTerminal: () => void;
  swarmCount: number;
}

export default function Sidebar({ theme, view, setView, terminalOpen, toggleTerminal, swarmCount }: Props) {
  return (
    <nav
      className="flex flex-col w-44 flex-shrink-0 py-2 border-r"
      style={{ background: theme.bgSecondary, borderColor: theme.border }}
    >
      {NAV.map(item => {
        const active = item.key === view;
        const badge = item.key === "swarm" && swarmCount > 0 ? `${swarmCount}/6` : null;
        return (
          <button
            key={item.key}
            onClick={() => setView(item.key)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors"
            style={{
              background: active ? theme.accentMuted : "transparent",
              color: active ? theme.accent : theme.textMuted,
              borderLeft: active ? `2px solid ${theme.accent}` : "2px solid transparent",
            }}
          >
            <span className="w-4 text-center text-xs opacity-60">{item.shortcut}</span>
            <span className="w-5 text-center">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {badge !== null && (
              <span
                className="text-xs px-1 rounded"
                style={{ background: theme.accentMuted, color: theme.accent, minWidth: 16, textAlign: "center" }}
              >
                {badge}
              </span>
            )}
          </button>
        );
      })}

      <PomodoroTimer theme={theme} />

      <button
        onClick={toggleTerminal}
        className="flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors mt-1"
        style={{
          background: terminalOpen ? theme.accentMuted : "transparent",
          color: terminalOpen ? theme.accent : theme.textMuted,
          borderLeft: `2px solid ${terminalOpen ? theme.accent : "transparent"}`,
        }}
      >
        <span className="w-4 text-center text-xs opacity-60">` </span>
        <span className="w-5 text-center text-xs">❯_</span>
        <span>Terminal</span>
      </button>

      <div className="mt-auto px-3 py-2 text-xs" style={{ color: theme.textDim }}>
        <div>t — theme</div>
        <div>` — terminal</div>
        <div>s — settings</div>
        <div>esc — back</div>
      </div>
    </nav>
  );
}
