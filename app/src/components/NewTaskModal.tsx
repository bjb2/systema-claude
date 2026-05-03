import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Theme } from "../themes";

interface Props {
  theme: Theme;
  orgRoot: string;
  onClose: () => void;
  onCreated?: (path: string) => void;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "untitled"
  );
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

export default function NewTaskModal({ theme, orgRoot, onClose, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const handleCreate = useCallback(async () => {
    const t = title.trim();
    if (!t || !orgRoot || saving) return;
    setSaving(true);
    setError(null);
    try {
      const slug = slugify(t);
      const sep = orgRoot.includes("\\") ? "\\" : "/";
      const path = `${orgRoot}${sep}tasks${sep}${slug}.md`;
      const content = `---
type: task
status: active
created: ${today()}
completed: null
tags: []
blocked-by: []
first-action: null
acceptance-criteria: null
---

# ${t}

## What

${body.trim()}

## Steps

- [ ]

`;
      await invoke("write_file", { path, content });
      onCreated?.(path);
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }, [title, body, orgRoot, saving, onCreated, onClose]);

  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleCreate();
    }
  }, [onClose, handleCreate]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        paddingTop: "12vh",
      }}
      onMouseDown={handleBackdrop}
      onKeyDown={handleKeyDown}
    >
      <div
        style={{
          width: "min(640px, 90vw)",
          background: theme.bgSecondary,
          border: `1px solid ${theme.border}`,
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
        }}
        onMouseDown={e => e.stopPropagation()}
      >
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px",
          borderBottom: `1px solid ${theme.border}`,
        }}>
          <span style={{ color: theme.accent, fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            New Task
          </span>
          <span style={{ fontSize: 11, color: theme.textDim, userSelect: "none" }}>
            Ctrl+Enter to create · Esc to cancel
          </span>
        </div>

        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            ref={titleRef}
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                void handleCreate();
              }
            }}
            placeholder="Task title..."
            style={{
              background: theme.bgTertiary,
              color: theme.text,
              border: `1px solid ${theme.accent}`,
              borderRadius: 4,
              padding: "8px 10px",
              fontSize: 14,
              outline: "none",
            }}
          />
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Notes (optional) — fills the What section..."
            rows={5}
            style={{
              background: theme.bgTertiary,
              color: theme.text,
              border: `1px solid ${theme.border}`,
              borderRadius: 4,
              padding: "8px 10px",
              fontSize: 13,
              outline: "none",
              resize: "vertical",
              fontFamily: "inherit",
            }}
          />
          {error && (
            <div style={{ color: theme.warning, fontSize: 12 }}>{error}</div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                padding: "5px 12px",
                background: "transparent",
                color: theme.textDim,
                fontSize: 12,
                borderRadius: 4,
              }}
            >
              cancel
            </button>
            <button
              onClick={() => void handleCreate()}
              disabled={saving || !title.trim()}
              style={{
                padding: "5px 14px",
                background: theme.accent,
                color: theme.bg,
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 4,
                opacity: saving || !title.trim() ? 0.5 : 1,
              }}
            >
              {saving ? "creating..." : "create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
