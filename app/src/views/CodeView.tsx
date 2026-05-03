import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ViewProps } from "../components/ViewProps";

interface FileEntry {
  path: string;
  name: string;
  size: number;
  extension: string;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  file?: FileEntry;
}

const EXT_COLORS: Record<string, string> = {
  ts: "#4ac8f0", tsx: "#4ac8f0", js: "#f0c44a", jsx: "#f0c44a",
  rs: "#f07040", py: "#4af076", md: "#c84af0", json: "#f0c44a",
  css: "#f04878", html: "#f07040", toml: "#f0c44a",
};

function buildTree(files: FileEntry[], rootDir: string): TreeNode {
  const sep = rootDir.includes("\\") ? "\\" : "/";
  const normalRoot = rootDir.replace(/[\\/]+$/, "");
  const root: TreeNode = {
    name: normalRoot.split(/[\\/]/).pop() ?? normalRoot,
    path: normalRoot,
    isDir: true,
    children: [],
  };

  files.forEach(file => {
    const rel = file.path.slice(normalRoot.length).replace(/^[\\/]/, "");
    const parts = rel.split(/[\\/]/);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      let child = node.children.find(c => c.isDir && c.name === dirName);
      if (!child) {
        child = {
          name: dirName,
          path: node.path + sep + dirName,
          isDir: true,
          children: [],
        };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({
      name: file.name,
      path: file.path,
      isDir: false,
      children: [],
      file,
    });
  });

  // Sort: dirs first, then files, both alphabetical
  const sortNode = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(c => { if (c.isDir) sortNode(c); });
  };
  sortNode(root);

  return root;
}

function TreeRow({
  node, depth, selectedPath, expanded, onToggle, onSelect, theme
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (file: FileEntry) => void;
  theme: import("../themes").Theme;
}) {
  const isOpen = expanded.has(node.path);
  const isSelected = !node.isDir && node.path === selectedPath;
  const extColor = node.file ? (EXT_COLORS[node.file.extension] ?? theme.textMuted) : theme.textDim;
  const indent = depth * 12;

  return (
    <>
      <button
        onClick={() => node.isDir ? onToggle(node.path) : node.file && onSelect(node.file)}
        className="w-full flex items-center gap-1.5 py-0.5 text-left text-xs border-b"
        style={{
          paddingLeft: `${indent + 8}px`,
          background: isSelected ? theme.accentMuted : "transparent",
          borderColor: theme.border,
          color: isSelected ? theme.accent : node.isDir ? theme.textMuted : theme.text,
        }}
      >
        {node.isDir ? (
          <span style={{ color: theme.textDim, fontSize: "9px", width: "10px" }}>
            {isOpen ? "▾" : "▸"}
          </span>
        ) : (
          <span style={{ color: extColor, fontSize: "9px", width: "10px" }}>·</span>
        )}
        <span className="truncate">{node.name}</span>
        {node.file && (
          <span className="ml-auto pr-2 flex-shrink-0" style={{ color: theme.textDim }}>
            {(node.file.size / 1024).toFixed(1)}k
          </span>
        )}
      </button>
      {node.isDir && isOpen && node.children.map(child => (
        <TreeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
          theme={theme}
        />
      ))}
    </>
  );
}

export default function CodeView({ theme, orgRoot }: ViewProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchDir, setSearchDir] = useState(orgRoot);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!searchDir) return;
    invoke<FileEntry[]>("list_code_files", { dir: searchDir })
      .then(result => {
        setFiles(result);
        // Auto-expand the root on first load
        setExpanded(new Set([searchDir.replace(/[\\/]+$/, "")]));
      })
      .catch(console.error);
  }, [searchDir]);

  const tree = useMemo(() => buildTree(files, searchDir), [files, searchDir]);

  const toggleDir = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const openFile = async (file: FileEntry) => {
    setSelectedFile(file);
    setEditing(false);
    const text = await invoke<string>("read_file", { path: file.path });
    setContent(text);
  };

  const save = async () => {
    if (!selectedFile) return;
    setSaving(true);
    try {
      await invoke("write_file", { path: selectedFile.path, content });
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  return (
    <div className="flex h-full">
      {/* File tree panel */}
      <div className="flex flex-col w-64 flex-shrink-0 border-r overflow-hidden" style={{ borderColor: theme.border }}>
        <div className="p-2 border-b flex-shrink-0" style={{ borderColor: theme.border }}>
          <input
            type="text"
            value={searchDir}
            onChange={e => setSearchDir(e.target.value)}
            className="w-full bg-transparent text-xs outline-none px-2 py-1 rounded border"
            style={{ borderColor: theme.border, color: theme.textMuted }}
          />
        </div>
        <div className="overflow-y-auto flex-1">
          {tree.children.map(child => (
            <TreeRow
              key={child.path}
              node={child}
              depth={0}
              selectedPath={selectedFile?.path ?? null}
              expanded={expanded}
              onToggle={toggleDir}
              onSelect={openFile}
              theme={theme}
            />
          ))}
        </div>
      </div>

      {/* Editor panel */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {selectedFile ? (
          <>
            <div
              className="flex items-center justify-between px-4 py-2 border-b text-xs flex-shrink-0"
              style={{ background: theme.bgTertiary, borderColor: theme.border }}
            >
              <span style={{ color: theme.textMuted }}>{selectedFile.path.replace(/\\/g, "/")}</span>
              <div className="flex gap-3">
                {editing ? (
                  <>
                    <button onClick={save} disabled={saving} className="px-2 py-0.5 rounded" style={{ background: theme.accent, color: theme.bg }}>
                      {saving ? "saving..." : "save (Ctrl+S)"}
                    </button>
                    <button onClick={() => setEditing(false)} style={{ color: theme.textMuted }}>cancel</button>
                  </>
                ) : (
                  <button onClick={() => setEditing(true)} style={{ color: theme.textMuted }}>edit</button>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {editing ? (
                <textarea
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  onKeyDown={e => { if (e.ctrlKey && e.key === "s") { e.preventDefault(); save(); } }}
                  className="w-full h-full resize-none outline-none text-xs font-mono"
                  style={{ background: "transparent", color: theme.text, caretColor: theme.accent }}
                  autoFocus
                />
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap" style={{ color: theme.text }}>{content}</pre>
              )}
            </div>
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-sm" style={{ color: theme.textDim }}>
            select a file
          </div>
        )}
      </div>
    </div>
  );
}
