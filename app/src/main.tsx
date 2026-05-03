import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

// Forward uncaught JS errors and rejections to the Rust log file so we can
// post-mortem a crashed/closed window. invoke is fire-and-forget; if the
// Tauri host is gone the .catch swallows it.
const fwd = (level: "error" | "warn", message: string, source: string) => {
  try { invoke("log_frontend_error", { level, message, source }).catch(() => {}); } catch {}
};
window.addEventListener("error", (e) => {
  const msg = `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}\n${e.error?.stack ?? ""}`;
  fwd("error", msg, "window.onerror");
});
window.addEventListener("unhandledrejection", (e) => {
  const reason: any = e.reason;
  const msg = reason?.stack ?? (typeof reason === "string" ? reason : JSON.stringify(reason));
  fwd("error", msg, "unhandledrejection");
});

// WebView2 on Windows doesn't reliably forward Ctrl+C/V browser accelerators to the
// web content. Implement them explicitly. xterm.js terminals (canvas elements) are
// excluded here — they register their own handler via attachCustomKeyEventHandler.
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (!e.ctrlKey || e.shiftKey || e.altKey) return;
  // xterm.js uses a hidden textarea for keyboard input (not canvas) — let attachCustomKeyEventHandler handle it
  if ((e.target as HTMLElement).closest?.('.xterm')) return;
  const key = e.key.toLowerCase();
  if (key === 'c') {
    const text = window.getSelection()?.toString();
    if (text) { e.preventDefault(); navigator.clipboard.writeText(text).catch(() => {}); }
  } else if (key === 'x') {
    const text = window.getSelection()?.toString();
    if (text) {
      e.preventDefault();
      navigator.clipboard.writeText(text).catch(() => {});
      document.execCommand('delete');
    }
  } else if (key === 'v') {
    const el = e.target as HTMLElement;
    if (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      e.preventDefault();
      navigator.clipboard.readText().then(text => {
        if (text) document.execCommand('insertText', false, text);
      }).catch(() => {});
    }
  }
}, { capture: true });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary label="app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
