import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Theme } from "../themes";
import { OrgDocument } from "../types";
import { searchDocs, highlightMatch, SearchResult } from "../lib/search";

const TYPE_ORDER = ["task", "knowledge", "inbox", "reminder"];
const DEBOUNCE_MS = 150;

interface Props {
  docs: OrgDocument[];
  theme: Theme;
  onSelect: (doc: OrgDocument) => void;
  onClose: () => void;
}

function typeLabel(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export default function SearchPalette({ docs, theme, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Debounce
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const results = useMemo(() => searchDocs(docs, debouncedQuery), [docs, debouncedQuery]);

  // Group by type in defined order
  const grouped = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of results) {
      const key = r.doc.type || "other";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    // Sort groups by TYPE_ORDER, then any remaining types
    const orderedKeys = [
      ...TYPE_ORDER.filter(k => map.has(k)),
      ...[...map.keys()].filter(k => !TYPE_ORDER.includes(k)),
    ];
    return orderedKeys.map(k => ({ type: k, items: map.get(k)! }));
  }, [results]);

  // Flat list for keyboard nav
  const flat = useMemo(() => results, [results]);

  useEffect(() => { setCursor(0); }, [debouncedQuery]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(c => Math.min(c + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(c => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      if (flat[cursor]) { onSelect(flat[cursor].doc); onClose(); }
    } else if (e.key === "Escape") {
      onClose();
    }
  }, [flat, cursor, onSelect, onClose]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector("[data-active='true']") as HTMLElement | null;
    active?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // Close on backdrop click
  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  let flatIdx = -1;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        paddingTop: "10vh",
      }}
      onMouseDown={handleBackdrop}
    >
      <div
        style={{
          width: "min(640px, 90vw)",
          background: theme.bgSecondary,
          border: `1px solid ${theme.border}`,
          borderRadius: "8px",
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
        }}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Input */}
        <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: `1px solid ${theme.border}`, gap: 10 }}>
          <span style={{ color: theme.textDim, fontSize: 16, lineHeight: 1 }}>⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="search everything..."
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              color: theme.text, fontSize: 14, fontFamily: "inherit",
            }}
          />
          <span style={{ fontSize: 11, color: theme.textDim, opacity: 0.7, userSelect: "none" }}>Esc</span>
        </div>

        {/* Results */}
        <div ref={listRef} style={{ maxHeight: "60vh", overflowY: "auto" }}>
          {debouncedQuery && results.length === 0 && (
            <div style={{ padding: "24px 16px", textAlign: "center", color: theme.textDim, fontSize: 13 }}>
              no results
            </div>
          )}
          {!debouncedQuery && (
            <div
              style={{
                padding: "20px 16px",
                color: theme.textDim,
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              <div style={{ marginBottom: 10 }}>type to search all documents</div>
              <div style={{ fontSize: 11, opacity: 0.85 }}>
                <div style={{ marginBottom: 4, color: theme.text }}>filters:</div>
                <code>kind:</code>epic|feature|task ·{" "}
                <code>parent:</code>&lt;slug&gt; ·{" "}
                <code>ready:</code>true|false ·{" "}
                <code>blocked:</code>true|false ·{" "}
                <code>tag:</code>&lt;name&gt;
                <div style={{ marginTop: 6, opacity: 0.7 }}>
                  e.g. <code>kind:epic ready:true</code> · <code>tag:org-viewer auth</code>
                </div>
              </div>
            </div>
          )}
          {grouped.map(group => {
            return (
              <div key={group.type}>
                <div style={{
                  padding: "6px 14px 3px",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: theme.textDim,
                }}>
                  {typeLabel(group.type)}
                </div>
                {group.items.map(result => {
                  flatIdx++;
                  const idx = flatIdx;
                  const isActive = cursor === idx;
                  return (
                    <div
                      key={result.doc.path}
                      data-active={isActive ? "true" : "false"}
                      onMouseMove={() => setCursor(idx)}
                      onClick={() => { onSelect(result.doc); onClose(); }}
                      style={{
                        padding: "7px 14px",
                        cursor: "pointer",
                        background: isActive ? theme.accentMuted : "transparent",
                        borderLeft: isActive ? `2px solid ${theme.accent}` : "2px solid transparent",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            fontSize: 11,
                            color: theme.text,
                            flex: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          dangerouslySetInnerHTML={{ __html: highlightMatch(result.doc.title, debouncedQuery) }}
                        />
                        {result.doc.status && (
                          <span style={{
                            fontSize: 10,
                            padding: "1px 5px",
                            borderRadius: 3,
                            border: `1px solid ${theme.border}`,
                            color: theme.textDim,
                            flexShrink: 0,
                          }}>
                            {result.doc.status}
                          </span>
                        )}
                      </div>
                      {result.snippet && (
                        <div
                          style={{
                            fontSize: 11,
                            color: theme.textMuted,
                            marginTop: 2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          dangerouslySetInnerHTML={{ __html: highlightMatch(result.snippet, debouncedQuery) }}
                        />
                      )}
                      {result.context && (
                        <div
                          style={{
                            fontSize: 10,
                            color: theme.textDim,
                            marginTop: 2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          dangerouslySetInnerHTML={{ __html: highlightMatch(result.context, debouncedQuery) }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        {results.length > 0 && (
          <div style={{
            display: "flex", gap: 16, padding: "6px 14px",
            borderTop: `1px solid ${theme.border}`,
            fontSize: 10, color: theme.textDim,
          }}>
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>Ctrl+K · Esc close</span>
          </div>
        )}
      </div>
    </div>
  );
}
