import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Theme } from "../themes";
import "@xterm/xterm/css/xterm.css";

interface Props {
  theme: Theme;
  orgRoot: string;
  visible: boolean;
  pendingClaudeTask?: { path: string; title: string } | null;
  onClaudeTaskHandled?: () => void;
  onRequestOpen?: () => void;
  getSwarmTargets?: () => { title: string; ptyId: number }[];
}


type ShellMode = "powershell" | "claude";

interface TermTab {
  id: string;
  mode: ShellMode;
  label: string;
  ptyId: number | null;
  terminal: Terminal;
  fitAddon: FitAddon;
}

let tabCounter = 0;

function makeTab(mode: ShellMode, theme: Theme): TermTab {
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    // Cascadia Code/Mono ships with Windows 11 and renders cleanly at all DPIs.
    // Fall through to Consolas (always present on Windows) then generic monospace.
    fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
    fontSize: 13,
    lineHeight: 1.0,
    letterSpacing: 0,
    fontWeight: "normal",
    fontWeightBold: "bold",
    allowProposedApi: true,
    scrollback: 5000,
    fastScrollModifier: "shift",
    // Keep colors faithful — don't auto-adjust for contrast
    minimumContrastRatio: 1,
    drawBoldTextInBrightColors: true,
    theme: {
      background: theme.bg,
      foreground: theme.text,
      cursor: theme.accent,
      cursorAccent: theme.bg,
      selectionBackground: theme.accentMuted,
      selectionForeground: theme.text,
      black:         "#1a1a2e",
      red:           theme.error,
      green:         theme.success,
      yellow:        theme.warning,
      blue:          "#4a8cf0",
      magenta:       "#c84af0",
      cyan:          "#4ac8f0",
      white:         "#d0d0e8",
      brightBlack:   theme.textDim,
      brightRed:     "#ff7060",
      brightGreen:   "#6eff90",
      brightYellow:  "#ffe060",
      brightBlue:    "#7aaaf8",
      brightMagenta: "#e07af8",
      brightCyan:    "#7ae8f8",
      brightWhite:   "#ffffff",
    },
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // Better emoji / wide-char handling
  const unicode11 = new Unicode11Addon();
  terminal.loadAddon(unicode11);
  terminal.unicode.activeVersion = "11";

  terminal.loadAddon(new WebLinksAddon());

  // Suppress OSC sequences from PSReadLine / shell integration that leak as visible text
  terminal.parser.registerOscHandler(7,   () => true); // working dir (PSReadLine)
  terminal.parser.registerOscHandler(133, () => true); // shell integration
  terminal.parser.registerOscHandler(633, () => true); // VS Code shell integration

  // Ctrl+C with selection → copy to clipboard (don't send SIGINT).
  // Ctrl+V → paste from clipboard into PTY (don't send \x16).
  terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown' || !e.ctrlKey || e.shiftKey || e.altKey) return true;
    if (e.key === 'c' && terminal.hasSelection()) {
      navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
      return false;
    }
    if (e.key === 'v') {
      navigator.clipboard.readText().then(text => { if (text) terminal.paste(text); }).catch(() => {});
      return false;
    }
    return true;
  });

  tabCounter++;
  return {
    id: `tab-${tabCounter}`,
    mode,
    label: mode === "claude" ? "claude" : "pwsh",
    ptyId: null,
    terminal,
    fitAddon,
  };
}

export default function TerminalView({ theme, orgRoot, visible, pendingClaudeTask, onClaudeTaskHandled }: Props) {
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const initRef = useRef(false);

  // Stable refs for routing inside the global hotkey closure
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  const activeTab = tabs.find(t => t.id === activeTabId) ?? null;

  // Global PTY output listener.
  // Uses a cancelled flag so cleanup works even when it runs before the async
  // listen() resolves — otherwise React StrictMode's double-mount leaves two
  // active listeners, writing every byte twice (doubled characters).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ pty_id: number; data: string }>("pty-output", ({ payload }) => {
      setTabs(prev => {
        const tab = prev.find(t => t.ptyId === payload.pty_id);
        if (tab) tab.terminal.write(payload.data);
        return prev;
      });
    }).then(fn => {
      if (cancelled) fn(); // already cleaned up — unlisten immediately
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const createTab = async (mode: ShellMode, labelOverride?: string) => {
    const tab = makeTab(mode, theme);
    if (labelOverride) tab.label = labelOverride;
    const shell = mode === "claude" ? "claude" : "powershell";
    try {
      const ptyId = await invoke<number>("pty_create", { shell, args: null, cwd: orgRoot });
      tab.ptyId = ptyId;
    } catch (e) {
      tab.terminal.write(`\r\nFailed to start ${mode}: ${e}\r\n`);
    }
    tab.terminal.onData(async (data) => {
      if (tab.ptyId != null) {
        await invoke("pty_write", { ptyId: tab.ptyId, data }).catch(() => {});
      }
    });
    setTabs(prev => [...prev, tab]);
    setActiveTabId(tab.id);
    return tab;
  };

  const closeTab = async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab?.ptyId != null) {
      await invoke("pty_kill", { ptyId: tab.ptyId }).catch(() => {});
    }
    tab?.terminal.dispose();
    setTabs(prev => prev.filter(t => t.id !== tabId));
    setActiveTabId(prev => {
      if (prev !== tabId) return prev;
      const remaining = tabs.filter(t => t.id !== tabId);
      return remaining[remaining.length - 1]?.id ?? null;
    });
  };

  // Mount/unmount terminal DOM element when active tab changes
  useEffect(() => {
    if (!containerRef.current || !activeTab) return;
    containerRef.current.innerHTML = "";
    activeTab.terminal.open(containerRef.current);
    // Prevent xterm's native paste-event handler from doubling our Ctrl+V paste.
    // Must use capture phase so this fires before xterm's textarea handler (inner elements fire first in bubble).
    // stopPropagation prevents the event from reaching the textarea entirely.
    activeTab.terminal.element?.addEventListener('paste', (e) => { e.preventDefault(); e.stopPropagation(); }, { capture: true });

    // WebGL renderer: much smoother font rendering than the default canvas.
    // Must be loaded after open(). Falls back silently if WebGL unavailable.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      activeTab.terminal.loadAddon(webgl);
    } catch {
      // canvas renderer fallback — no action needed
    }

    activeTab.fitAddon.fit();
    // Delay focus so the focus-in escape sequence (\e[I) doesn't land during
    // PSReadLine's initial prompt render, which causes a duplicate directory line.
    const t = setTimeout(() => activeTab.terminal.focus(), 80);
    return () => clearTimeout(t);
  }, [activeTabId, activeTab]);

  // Handle resize
  useEffect(() => {
    if (!activeTab) return;
    const ro = new ResizeObserver(() => {
      // Skip resize when hidden (0-width container) — fit() with 0 cols corrupts the PTY
      if (!containerRef.current || containerRef.current.offsetWidth === 0 || containerRef.current.offsetHeight === 0) return;
      activeTab.fitAddon.fit();
      const { rows, cols } = activeTab.terminal;
      if (activeTab.ptyId != null) {
        invoke("pty_resize", { ptyId: activeTab.ptyId, rows, cols }).catch(() => {});
      }
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [activeTabId, activeTab]);

  // Refit when sidebar becomes visible
  useEffect(() => {
    if (!visible || !activeTab) return;
    const t = setTimeout(() => {
      activeTab.fitAddon.fit();
      const { rows, cols } = activeTab.terminal;
      if (activeTab.ptyId != null) {
        invoke("pty_resize", { ptyId: activeTab.ptyId, rows, cols }).catch(() => {});
      }
    }, 60);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Spawn Claude tab when a task is dispatched
  useEffect(() => {
    if (!pendingClaudeTask) return;
    const spawn = async () => {
      const tab = await createTab("claude", pendingClaudeTask.title.slice(0, 16));
      setTimeout(() => {
        if (tab.ptyId != null) {
          invoke("pty_write", {
            ptyId: tab.ptyId,
            data: `Read and work on this task: "${pendingClaudeTask.path}"\r`,
          }).catch(() => {});
        }
      }, 1500);
      onClaudeTaskHandled?.();
    };
    spawn();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingClaudeTask]);

  // Open a default PowerShell tab on first mount — ref guard prevents StrictMode double-fire
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    createTab("powershell");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col h-full" style={{ background: theme.bg }}>
      {/* Tab bar */}
      <div
        className="flex items-center gap-1 px-2 py-1 border-b flex-shrink-0"
        style={{ borderColor: theme.border, background: theme.bgSecondary }}
      >
        {tabs.map(tab => (
          <div
            key={tab.id}
            className="flex items-center gap-1"
            style={{
              background: tab.id === activeTabId ? theme.bgTertiary : "transparent",
              border: `1px solid ${tab.id === activeTabId ? theme.border : "transparent"}`,
              borderRadius: "4px",
              padding: "1px 6px",
            }}
          >
            <button
              onClick={() => setActiveTabId(tab.id)}
              className="text-xs"
              style={{ color: tab.id === activeTabId ? theme.text : theme.textMuted }}
            >
              <span style={{ color: tab.mode === "claude" ? "#7c6af5" : theme.success, marginRight: "4px" }}>❯</span>
              {tab.label}
            </button>
            <button
              onClick={() => closeTab(tab.id)}
              className="text-xs ml-1"
              style={{ color: theme.textDim }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          onClick={() => createTab("powershell")}
          className="text-xs px-2 py-0.5 rounded"
          style={{ color: theme.textDim }}
          title="New PowerShell tab"
        >
          + pwsh
        </button>
        <button
          onClick={() => createTab("claude")}
          className="text-xs px-2 py-0.5 rounded"
          style={{ color: theme.textDim }}
          title="New Claude tab"
        >
          + claude
        </button>
      </div>

      {/* Terminal container */}
      <div ref={containerRef} className="flex-1 overflow-hidden p-1" />
    </div>
  );
}
