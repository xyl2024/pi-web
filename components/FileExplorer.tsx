"use client";

import { useState, useCallback, useEffect, useRef } from "react";
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
  onAtMention?: (filePath: string) => void;
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
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (filePath: string) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshKey?: number;
  onFileMutated?: () => void;
  onFileDeleted?: (filePath: string) => void;
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
      { key: "rename", label: t("Rename"), onSelect: () => { setRenameValue(node.name); setRenameError(null); setRenaming(true); } },
      { key: "sep2", separatorBefore: true, label: "", onSelect: () => {} },
      { key: "delete", label: t("Delete"), destructive: true, onSelect: () => { onDelete(); } },
    ];
    cm.open({ x: e.clientX, y: e.clientY, items });
  }, [node, cwd, t, copyText, onOpenFile, onDelete, cm]);

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
              {node.name}
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
              onAtMention(node.fullPath);
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
            />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              {t("empty")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ cwd, onOpenFile, refreshKey, onAtMention, onFileMutated, onFileDeleted }: Props) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
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
    }

    setLoading(cwdChanged);
    setError(null);
    fetchEntries(cwd)
      .then((entries) => setRoots(entries))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cwd, refreshKey]);

  if (loading) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
        {t("Loading files...")}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>
        {error}
      </div>
    );
  }

  return (
    <div>
      <div style={{ padding: "2px 4px" }}>
        {roots.map((node) => (
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
          />
        ))}
        {roots.length === 0 && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
            {t("No files found")}
          </div>
        )}
      </div>
    </div>
  );
}
