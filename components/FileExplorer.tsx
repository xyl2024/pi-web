"use client";

import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { encodeFilePathForApi, getRelativeFilePath, joinFilePath } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";
import { Tooltip } from "./Tooltip";
import { useToast } from "./Toast";
import { useConfirm } from "./ConfirmDialog";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { validateFileName } from "@/lib/file-name";

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string) => void;
  onFileMutated?: () => void;
  onFileDeleted?: (filePath: string) => void;
}

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) return [];
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshKey,
  onFileMutated,
  onFileDeleted,
  searchTerm,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshKey?: number;
  onFileMutated?: () => void;
  onFileDeleted?: (filePath: string) => void;
  searchTerm: string;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const cm = useContextMenu();
  const open = expandedPaths.has(node.fullPath);
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"file" | "folder" | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [flashHighlight, setFlashHighlight] = useState(false);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath]);

  // Re-fetch children when refreshKey changes and the directory is already open/loaded
  useEffect(() => {
    if (open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const handleClick = useCallback(() => {
    if (renaming) return;
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded, renaming]);

  // ---- context menu ----
  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    toast.show({ kind: "success", message: t("Copied") });
  }, [toast, t]);

  const onDelete = useCallback(async () => {
    const ok = await confirm({
      title: node.isDir ? t("Delete folder?") : t("Delete file?"),
      description: node.name,
      confirmLabel: t("Delete"),
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/files/${encodeFilePathForApi(node.fullPath)}`, { method: "DELETE" });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "" }));
        toast.show({ kind: "error", message: error || t("Delete failed") });
        return;
      }
      toast.show({ kind: "success", message: t("Deleted") });
      onFileDeleted?.(node.fullPath);
      onFileMutated?.();
    } catch {
      toast.show({ kind: "error", message: t("Network error") });
    }
  }, [node, confirm, t, toast, onFileDeleted, onFileMutated]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rel = getRelativeFilePath(node.fullPath, cwd);
    const items: ContextMenuItem[] = [
      {
        key: "open",
        label: t("Open"),
        onSelect: () => { if (!node.isDir) onOpenFile(node.fullPath, node.name); },
        disabled: node.isDir,
      },
      { key: "copy_abs", label: t("Copy absolute path"), onSelect: () => copyText(node.fullPath) },
      { key: "copy_rel", label: t("Copy relative path"), onSelect: () => copyText(rel) },
      { key: "copy_at", label: t("Copy as @-mention"), onSelect: () => copyText("`" + rel + "`") },
      { key: "sep1", separatorBefore: true, label: "", onSelect: () => {} },
      { key: "new_file", label: t("New file"), onSelect: () => { if (node.isDir) { onToggleExpanded(node.fullPath, true); if (!loaded) loadChildren(); setCreating("file"); } } },
      { key: "new_folder", label: t("New folder"), onSelect: () => { if (node.isDir) { onToggleExpanded(node.fullPath, true); if (!loaded) loadChildren(); setCreating("folder"); } } },
      { key: "rename", label: t("Rename"), onSelect: () => { setRenameValue(node.name); setRenameError(null); setRenaming(true); } },
      { key: "sep2", separatorBefore: true, label: "", onSelect: () => {} },
      { key: "delete", label: t("Delete"), destructive: true, onSelect: () => { onDelete(); } },
    ];
    cm.open({ x: e.clientX, y: e.clientY, items });
  }, [node, cwd, t, copyText, onOpenFile, onToggleExpanded, loaded, loadChildren, onDelete, cm]);

  // ---- rename submit ----
  const submitRename = useCallback(async () => {
    const v = validateFileName(renameValue);
    if (!v.ok) {
      setRenameError(v.message);
      return;
    }
    if (v.name === node.name) {
      setRenaming(false);
      setRenameError(null);
      return;
    }
    // Optimistic duplicate check against loaded siblings (best-effort; backend is authoritative)
    if (children.some((c) => c.name === v.name)) {
      setRenameError(t("Name already exists"));
      return;
    }
    try {
      const res = await fetch(`/api/files/${encodeFilePathForApi(node.fullPath)}?type=rename`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName: v.name }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "" }));
        setRenameError(error || t("Rename failed"));
        return;
      }
      setRenaming(false);
      setRenameError(null);
      setFlashHighlight(true);
      setTimeout(() => setFlashHighlight(false), 1000);
      toast.show({ kind: "success", message: t("Renamed") });
      onFileMutated?.();
    } catch {
      setRenameError(t("Network error"));
    }
  }, [renameValue, node, children, t, toast, onFileMutated]);

  // ---- create submit (only used when this node is a directory and `creating` set) ----
  const submitCreate = useCallback(async () => {
    const v = validateFileName(createValue);
    if (!v.ok) {
      setCreateError(v.message);
      return;
    }
    if (children.some((c) => c.name === v.name)) {
      setCreateError(t("Name already exists"));
      return;
    }
    if (!node.isDir) return;
    const op = creating; // "file" | "folder"
    if (!op) return;
    try {
      const res = await fetch(`/api/files/${encodeFilePathForApi(node.fullPath)}?type=${op === "file" ? "create" : "mkdir"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: v.name }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "" }));
        setCreateError(error || t("Create failed"));
        return;
      }
      setCreating(null);
      setCreateValue("");
      setCreateError(null);
      setFlashHighlight(true);
      setTimeout(() => setFlashHighlight(false), 1000);
      toast.show({ kind: "success", message: op === "file" ? t("File created") : t("Folder created") });
      onFileMutated?.();
    } catch {
      setCreateError(t("Network error"));
    }
  }, [createValue, creating, node, children, t, toast, onFileMutated]);

  return (
    <div>
      <div
        onClick={renaming ? undefined : handleClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          height: 24,
          cursor: renaming ? "default" : "pointer",
          background: flashHighlight
            ? "var(--bg-selected)"
            : hovered
              ? "var(--bg-hover)"
              : "transparent",
          borderRadius: 4,
          userSelect: "none",
          transition: "background 0.3s",
        }}
      >
        {node.isDir && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        {renaming ? (
          <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => { setRenameValue(e.target.value); setRenameError(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setRenaming(false);
                  setRenameError(null);
                }
              }}
              onBlur={() => {
                // If user hasn't submitted and value matches, cancel silently.
                if (renameValue === node.name) {
                  setRenaming(false);
                  setRenameError(null);
                }
                // Otherwise leave the input open with error if any; the user
                // can press Enter or click back into it.
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                fontSize: 12,
                padding: "1px 4px",
                border: "1px solid " + (renameError ? "#f87171" : "var(--accent)"),
                borderRadius: 3,
                background: "var(--bg)",
                color: "var(--text)",
                outline: "none",
                width: "100%",
              }}
            />
            {renameError && (
              <span style={{ fontSize: 10, color: "#f87171" }}>{renameError}</span>
            )}
          </span>
        ) : (
          <Tooltip content={node.fullPath}>
            <span
              style={{
                fontSize: 12,
                color: "var(--text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {highlightMatch(node.name, searchTerm)}
            </span>
          </Tooltip>
        )}
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {onAtMention && hovered && !renaming && (
          <Tooltip content={t("Insert path into chat")}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd));
            }}
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
            </svg>
            {t("mention")}
          </button>
          </Tooltip>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshKey={refreshKey}
              onFileMutated={onFileMutated}
              onFileDeleted={onFileDeleted}
              searchTerm={searchTerm}
            />
          ))}
          {creating && (
            <InlineInputRow
              depth={depth + 1}
              mode={creating}
              value={createValue}
              error={createError}
              onChange={(v) => { setCreateValue(v); setCreateError(null); }}
              onSubmit={submitCreate}
              onCancel={() => { setCreating(null); setCreateValue(""); setCreateError(null); }}
            />
          )}
          {children.length === 0 && loaded && !creating && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              {t("empty")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InlineInputRow({
  depth,
  mode,
  value,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  depth: number;
  mode: "file" | "folder";
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        paddingLeft: 8 + depth * 14,
        paddingRight: 8,
        paddingTop: 2,
        paddingBottom: 2,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ width: 10, flexShrink: 0 }} />
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center", color: "var(--text-dim)" }}>
          {mode === "folder" ? (
            <FolderIcon size={14} open={false} />
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          )}
        </span>
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => {
            // Cancel on blur if empty or no error to preserve; keep open with
            // error so user can fix it. If empty and not errored, cancel.
            if (!value.trim() && !error) onCancel();
          }}
          placeholder={mode === "folder" ? "folder name" : "filename.ext"}
          style={{
            fontSize: 12,
            padding: "1px 4px",
            border: "1px solid " + (error ? "#f87171" : "var(--accent)"),
            borderRadius: 3,
            background: "var(--bg)",
            color: "var(--text)",
            outline: "none",
            flex: 1,
          }}
        />
      </div>
      {error && (
        <span style={{ fontSize: 10, color: "#f87171", paddingLeft: 18 }}>{error}</span>
      )}
    </div>
  );
}

function highlightMatch(name: string, term: string): ReactNode {
  if (!term) return name;
  const lower = name.toLowerCase();
  const t = term.toLowerCase();
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < name.length) {
    const idx = lower.indexOf(t, i);
    if (idx === -1) break;
    ranges.push([idx, idx + t.length]);
    i = idx + t.length;
  }
  if (!ranges.length) return name;
  const out: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([s, e], k) => {
    if (s > cursor) out.push(name.slice(cursor, s));
    out.push(
      <mark
        key={k}
        style={{ background: "var(--bg-selected)", color: "inherit", borderRadius: 2, padding: "0 1px" }}
      >
        {name.slice(s, e)}
      </mark>
    );
    cursor = e;
  });
  if (cursor < name.length) out.push(name.slice(cursor));
  return out;
}

export function FileExplorer({ cwd, onOpenFile, refreshKey, onAtMention, onFileMutated, onFileDeleted }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const cm = useContextMenu();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [rootCreating, setRootCreating] = useState<"file" | "folder" | null>(null);
  const [rootCreateValue, setRootCreateValue] = useState("");
  const [rootCreateError, setRootCreateError] = useState<string | null>(null);
  const prevCwdRef = useRef<string | null>(null);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) {
      setExpandedPaths(new Set());
      setSearchTerm("");
      setRootCreating(null);
    }

    setLoading(cwdChanged);
    setError(null);
    fetchEntries(cwd)
      .then((entries) => setRoots(entries))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cwd, refreshKey]);

  // Search filtering: derive displayRoots (only filters by name; not by content)
  const filteredRoots = useMemo(() => {
    if (!searchTerm) return roots;
    const term = searchTerm.toLowerCase();
    const match = (n: FileNode): boolean => n.name.toLowerCase().includes(term);
    const recurse = (n: FileNode): FileNode | null => {
      if (!n.isDir) {
        return match(n) ? n : null;
      }
      if (match(n)) return n;
      if (!expandedPaths.has(n.fullPath) || !n.loaded) {
        // Don't recurse into unexpanded dirs
        return null;
      }
      const filteredChildren = (n.children ?? []).map(recurse).filter(Boolean) as FileNode[];
      if (filteredChildren.length === 0) return null;
      return { ...n, children: filteredChildren };
    };
    return roots.map(recurse).filter(Boolean) as FileNode[];
  }, [roots, searchTerm, expandedPaths]);

  const submitRootCreate = useCallback(async () => {
    const v = validateFileName(rootCreateValue);
    if (!v.ok) {
      setRootCreateError(v.message);
      return;
    }
    if (roots.some((r) => r.name === v.name)) {
      setRootCreateError(t("Name already exists"));
      return;
    }
    const op = rootCreating;
    if (!op) return;
    try {
      const res = await fetch(`/api/files/${encodeFilePathForApi(cwd)}?type=${op === "file" ? "create" : "mkdir"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: v.name }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "" }));
        setRootCreateError(error || t("Create failed"));
        return;
      }
      setRootCreating(null);
      setRootCreateValue("");
      setRootCreateError(null);
      toast.show({ kind: "success", message: op === "file" ? t("File created") : t("Folder created") });
      onFileMutated?.();
    } catch {
      setRootCreateError(t("Network error"));
    }
  }, [rootCreateValue, rootCreating, roots, cwd, t, toast, onFileMutated]);

  if (loading) {
    return (
      <div>
        <ExplorerToolbar
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          onNewFile={() => { setRootCreating("file"); setRootCreateValue(""); setRootCreateError(null); }}
          onNewFolder={() => { setRootCreating("folder"); setRootCreateValue(""); setRootCreateError(null); }}
        />
        <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
          {t("Loading files...")}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <ExplorerToolbar
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          onNewFile={() => { setRootCreating("file"); setRootCreateValue(""); setRootCreateError(null); }}
          onNewFolder={() => { setRootCreating("folder"); setRootCreateValue(""); setRootCreateError(null); }}
        />
        <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>
          {error}
        </div>
      </div>
    );
  }

  return (
    <div
      onContextMenu={(e) => {
        // Only trigger if the user right-clicked the empty area (not a TreeNode)
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        cm.open({
          x: e.clientX,
          y: e.clientY,
          items: [
            { key: "new_file", label: t("New file"), onSelect: () => { setRootCreating("file"); setRootCreateValue(""); setRootCreateError(null); } },
            { key: "new_folder", label: t("New folder"), onSelect: () => { setRootCreating("folder"); setRootCreateValue(""); setRootCreateError(null); } },
          ],
        });
      }}
    >
      <ExplorerToolbar
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        onNewFile={() => { setRootCreating("file"); setRootCreateValue(""); setRootCreateError(null); }}
        onNewFolder={() => { setRootCreating("folder"); setRootCreateValue(""); setRootCreateError(null); }}
      />
      <div style={{ padding: "2px 4px" }}>
        {filteredRoots.map((node) => (
          <TreeNode
            key={node.fullPath}
            node={node}
            depth={0}
            cwd={cwd}
            onOpenFile={onOpenFile}
            onAtMention={onAtMention}
            expandedPaths={expandedPaths}
            onToggleExpanded={handleToggleExpanded}
            refreshKey={refreshKey}
            onFileMutated={onFileMutated}
            onFileDeleted={onFileDeleted}
            searchTerm={searchTerm}
          />
        ))}
        {rootCreating && (
          <InlineInputRow
            depth={0}
            mode={rootCreating}
            value={rootCreateValue}
            error={rootCreateError}
            onChange={(v) => { setRootCreateValue(v); setRootCreateError(null); }}
            onSubmit={submitRootCreate}
            onCancel={() => { setRootCreating(null); setRootCreateValue(""); setRootCreateError(null); }}
          />
        )}
        {filteredRoots.length === 0 && !rootCreating && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
            {searchTerm ? t("No matches") : t("No files found")}
          </div>
        )}
      </div>
    </div>
  );
}

function ExplorerToolbar({
  searchTerm,
  onSearchChange,
  onNewFile,
  onNewFolder,
}: {
  searchTerm: string;
  onSearchChange: (v: string) => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        padding: "4px 6px",
        borderBottom: "1px solid var(--border)",
        alignItems: "center",
      }}
    >
      <input
        value={searchTerm}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={t("Search files…")}
        aria-label={t("Search files…")}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          padding: "3px 8px",
          border: "1px solid var(--border)",
          borderRadius: 4,
          background: "var(--bg)",
          color: "var(--text)",
          outline: "none",
        }}
      />
      <Tooltip content={t("New file")}>
        <button
          onClick={onNewFile}
          aria-label={t("New file")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            padding: 0,
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-dim)",
            cursor: "pointer",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-dim)"; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip content={t("New folder")}>
        <button
          onClick={onNewFolder}
          aria-label={t("New folder")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            padding: 0,
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-dim)",
            cursor: "pointer",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-dim)"; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line x1="12" y1="11" x2="12" y2="17" />
            <line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}
