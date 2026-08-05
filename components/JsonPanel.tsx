"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { parseJsonTolerant, escapeJsonString } from "@/lib/json-parser";
import {
  JsonTreeView,
  collectAllContainerPaths,
  collectContainerPathsAtDepth,
  findMatches,
  getAtPath,
  parsePathKey,
  pathKey,
  type JsonPath,
  type JsonValue,
  type SearchMatch,
} from "./JsonTreeView";

type View = "textarea" | "tree";

const DEFAULT_COLLAPSE_DEPTH = 3;
const PARSE_DEBOUNCE_MS = 250;
const STORAGE_KEY = "pi-json-panel-content";

const ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

// Lucide-derived icons (24x24, stroke=currentColor, strokeWidth=1.8).
// Each one is paired with its tooltip label below.
const ICONS: Record<string, ReactNode> = {
  // Copy minify (diagonal arrows compressing)
  minify: (
    <svg {...ICON_PROPS}>
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  ),
  // Copy minify & escape (document with text lines)
  escape: (
    <svg {...ICON_PROPS}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
      <line x1="11" y1="11" x2="14" y2="11" />
      <line x1="11" y1="15" x2="14" y2="15" />
      <line x1="11" y1="19" x2="14" y2="19" />
    </svg>
  ),
  // Tree view (git-branch)
  tree: (
    <svg {...ICON_PROPS}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  ),
  // Collapse all (chevrons-up)
  collapseAll: (
    <svg {...ICON_PROPS}>
      <polyline points="17 11 12 6 7 11" />
      <polyline points="17 18 12 13 7 18" />
    </svg>
  ),
  // Expand all (chevrons-down)
  expandAll: (
    <svg {...ICON_PROPS}>
      <polyline points="7 13 12 18 17 13" />
      <polyline points="7 6 12 11 17 6" />
    </svg>
  ),
  // Copy (two overlapping rectangles)
  copy: (
    <svg {...ICON_PROPS}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  // Clear (trash)
  clear: (
    <svg {...ICON_PROPS}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  ),
  // Search (magnifying glass)
  search: (
    <svg {...ICON_PROPS}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  // Chevron up (previous match)
  chevronUp: (
    <svg {...ICON_PROPS}>
      <polyline points="18 15 12 9 6 15" />
    </svg>
  ),
  // Chevron down (next match)
  chevronDown: (
    <svg {...ICON_PROPS}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  // Close / clear search (X)
  close: (
    <svg {...ICON_PROPS}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
};

export function JsonPanel() {
  const { t } = useI18n();
  const toast = useToast();
  const [content, setContent] = useState("");
  const [view, setView] = useState<View>("textarea");
  const [debouncedContent, setDebouncedContent] = useState("");
  const [error, setError] = useState<{ message: string; ignoredPrefix?: string; ignoredSuffix?: string } | null>(null);
  const [parsed, setParsed] = useState<JsonValue | null>(null);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const initializedRef = useRef(false);
  // Gates the first persist run so the initial empty state doesn't overwrite
  // the data we are about to rehydrate from localStorage.
  const persistInitializedRef = useRef(false);

  // --- Search state ---
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lineRefsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const panelRef = useRef<HTMLDivElement>(null);

  const trimmedQuery = searchQuery.trim();
  const matches = useMemo<SearchMatch[]>(() => {
    if (!parsed || trimmedQuery.length === 0) return [];
    return findMatches(parsed, trimmedQuery);
  }, [parsed, trimmedQuery]);

  // Restore the last-edited JSON from localStorage on mount.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (typeof saved === "string") setContent(saved);
    } catch { /* localStorage unavailable — keep default */ }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedContent(content), PARSE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [content]);

  useEffect(() => {
    if (!persistInitializedRef.current) {
      persistInitializedRef.current = true;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, content);
    } catch { /* quota exceeded / unavailable — ignore */ }
  }, [content]);

  useEffect(() => {
    if (debouncedContent.length === 0) {
      setError(null);
      setParsed(null);
      return;
    }
    const result = parseJsonTolerant(debouncedContent);
    if (!result.ok) {
      setError({ message: result.error });
      setParsed(null);
      return;
    }
    setError(
      result.ignoredPrefix || result.ignoredSuffix
        ? { message: "", ignoredPrefix: result.ignoredPrefix, ignoredSuffix: result.ignoredSuffix }
        : null,
    );
    const value = result.value as JsonValue;
    setParsed(value);

    if (!initializedRef.current) {
      initializedRef.current = true;
      setCollapsedPaths(new Set(collectContainerPathsAtDepth(value, DEFAULT_COLLAPSE_DEPTH)));
    } else {
      setCollapsedPaths((prev) => {
        const next = new Set<string>();
        for (const k of prev) {
          if (getAtPath(value, parsePathKey(k)).container) next.add(k);
        }
        return next;
      });
    }
  }, [debouncedContent]);

  // --- Search effects ---

  // Clamp currentMatchIndex whenever the match list shrinks to avoid stale paths.
  useEffect(() => {
    if (matches.length === 0) { setCurrentMatchIndex(0); return; }
    setCurrentMatchIndex((idx) => Math.min(Math.max(idx, 0), matches.length - 1));
  }, [matches]);

  // Auto-expand every ancestor of the active match so it becomes visible.
  useEffect(() => {
    if (!parsed || matches.length === 0) return;
    const idx = Math.min(currentMatchIndex, matches.length - 1);
    const path = matches[idx].path;
    if (path.length === 0) return;
    setCollapsedPaths((prev) => {
      let next: Set<string> | null = null;
      for (let i = 1; i < path.length; i++) {
        const k = pathKey(path.slice(0, i));
        if (prev.has(k)) { next ??= new Set(prev); next.delete(k); }
      }
      return next ?? prev;
    });
  }, [currentMatchIndex, matches, parsed]);

  // Scroll the active line into view. Depends on collapsedPaths so we retry after
  // the auto-expand above propagates and renders the previously-hidden line.
  useLayoutEffect(() => {
    if (matches.length === 0) return;
    const idx = Math.min(currentMatchIndex, matches.length - 1);
    const lineIndex = matches[idx].lineIndex;
    const el = lineRefsRef.current.get(lineIndex);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentMatchIndex, matches, collapsedPaths]);

  // Cmd/Ctrl+F focuses the search input (only when focus is NOT inside this panel
  // and we are in tree view with a parsed value).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      if (view !== "tree" || !parsed) return;
      // If focus is already inside the panel, leave the browser's native find alone.
      if (panelRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [view, parsed]);

  const goNext = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((i) => (i + 1) % matches.length);
  }, [matches.length]);

  const goPrev = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((i) => (i - 1 + matches.length) % matches.length);
  }, [matches.length]);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setCurrentMatchIndex(0);
  }, []);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev(); else goNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      clearSearch();
      e.currentTarget.blur();
    }
  }, [goNext, goPrev, clearSearch]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData("text/plain");
    if (pasted.length === 0) {
      // Nothing to read — fall back to whatever the browser pasted (e.g. dropped file content).
      return;
    }
    e.preventDefault();
    const result = parseJsonTolerant(pasted);
    if (result.ok) {
      setContent(JSON.stringify(result.value as JsonValue, null, 2));
    } else {
      setContent(pasted);
    }
  }, []);

  const handleCopyMinify = useCallback(async () => {
    if (parsed === null) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(parsed));
      toast.show({ kind: "success", message: t("Copied") });
    } catch {
      toast.show({ kind: "error", message: t("Failed to copy") });
    }
  }, [parsed, t, toast]);

  const handleCopyMinifyEscape = useCallback(async () => {
    if (parsed === null) return;
    try {
      await navigator.clipboard.writeText(escapeJsonString(parsed));
      toast.show({ kind: "success", message: t("Copied") });
    } catch {
      toast.show({ kind: "error", message: t("Failed to copy") });
    }
  }, [parsed, t, toast]);

  const handleToggleTree = useCallback(() => {
    if (parsed === null) return;
    setView((v) => (v === "tree" ? "textarea" : "tree"));
  }, [parsed]);

  const handleCollapseAll = useCallback(() => {
    if (parsed === null) return;
    setCollapsedPaths(new Set(collectAllContainerPaths(parsed)));
  }, [parsed]);

  const handleExpandAll = useCallback(() => setCollapsedPaths(new Set()), []);

  const togglePath = useCallback((path: JsonPath) => {
    const key = pathKey(path);
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleClear = useCallback(() => {
    setContent("");
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  const isTreeView = view === "tree";
  const disableTransform = parsed === null;
  const activeLineIndex = matches.length > 0
    ? matches[Math.min(currentMatchIndex, matches.length - 1)].lineIndex
    : -1;

  return (
    <div ref={panelRef} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={toolbarStyle}>
        <IconButton label={t("Tree view")} icon={ICONS.tree} active={isTreeView} onClick={handleToggleTree} disabled={disableTransform} />
        {isTreeView && (
          <>
            <div style={toolbarDividerStyle} />
            <IconButton label={t("Collapse all")} icon={ICONS.collapseAll} onClick={handleCollapseAll} disabled={disableTransform} />
            <IconButton label={t("Expand all")} icon={ICONS.expandAll} onClick={handleExpandAll} disabled={disableTransform} />
          </>
        )}
        <div style={{ flex: 1 }} />
        <ErrorBadge error={error} ignoredPrefix={error?.ignoredPrefix} ignoredSuffix={error?.ignoredSuffix} />
        <IconButton label={t("Clear")} icon={ICONS.clear} onClick={handleClear} disabled={content.length === 0} />
        <IconButton label={t("Copy minify")} icon={ICONS.minify} onClick={handleCopyMinify} disabled={disableTransform} />
        <IconButton label={t("Copy minify & escape")} icon={ICONS.escape} onClick={handleCopyMinifyEscape} disabled={disableTransform} />
      </div>

      {isTreeView && (
        <div style={searchRowStyle}>
          <span style={searchIconStyle}>{ICONS.search}</span>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t("Search")}
            spellCheck={false}
            style={searchInputStyle}
            aria-label={t("Search")}
          />
          {trimmedQuery.length > 0 && (
            <>
              <span style={matchCounterStyle}>
                {matches.length === 0
                  ? t("No matches")
                  : t("Match {n} of {total}")
                      .replace("{n}", String(Math.min(currentMatchIndex, matches.length - 1) + 1))
                      .replace("{total}", String(matches.length))}
              </span>
              <IconButton
                label={t("Previous match")}
                icon={ICONS.chevronUp}
                onClick={goPrev}
                disabled={matches.length === 0}
              />
              <IconButton
                label={t("Next match")}
                icon={ICONS.chevronDown}
                onClick={goNext}
                disabled={matches.length === 0}
              />
              <IconButton
                label={t("Clear search")}
                icon={ICONS.close}
                onClick={clearSearch}
              />
            </>
          )}
        </div>
      )}

      {isTreeView ? (
        <div style={viewerStyle}>
          {parsed ? (
            <JsonTreeView
              value={parsed}
              collapsedPaths={collapsedPaths}
              onTogglePath={togglePath}
              search={
                trimmedQuery.length === 0
                  ? undefined
                  : {
                      query: trimmedQuery,
                      activeLineIndex,
                      onLineRef: (i, el) => {
                        if (el) lineRefsRef.current.set(i, el);
                        else lineRefsRef.current.delete(i);
                      },
                    }
              }
            />
          ) : (
            <div style={{ color: "#f87171", whiteSpace: "pre-wrap" }}>
              {error ? t("Parse error: {error}").replace("{error}", error.message) : t("Paste JSON here…")}
            </div>
          )}
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onPaste={handlePaste}
          placeholder={t("Paste JSON here…")}
          spellCheck={false}
          style={contentAreaStyle}
        />
      )}
    </div>
  );
}

const contentAreaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  background: "var(--bg)",
  color: "var(--text)",
  border: "none",
  outline: "none",
  resize: "none",
  padding: "10px 14px",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.55,
  whiteSpace: "pre",
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "6px 10px",
  background: "var(--bg-panel)",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

const toolbarDividerStyle: React.CSSProperties = {
  width: 1,
  height: 16,
  background: "var(--border)",
  margin: "0 6px",
};

const searchRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  background: "var(--bg-panel)",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

const searchIconStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  color: "var(--text-muted)",
};

const searchInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "4px 8px",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  outline: "none",
};

const matchCounterStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  minWidth: 72,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const viewerStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  background: "var(--bg)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.55,
  padding: "10px 14px",
  whiteSpace: "pre",
  color: "var(--text)",
};

function IconButton({ label, icon, active, onClick, disabled }: { label: string; icon: ReactNode; active?: boolean; onClick: () => void; disabled?: boolean }) {
  const baseColor = disabled ? "var(--text-dim)" : active ? "var(--text)" : "var(--text-muted)";
  const baseBg = active ? "var(--bg-selected)" : "transparent";
  const hoverBg = active ? "var(--bg-selected)" : "var(--bg-hover)";
  const hoverColor = disabled ? "var(--text-dim)" : "var(--text)";
  return (
    <Tooltip content={label}>
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        style={{
          width: 28,
          height: 28,
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: baseBg,
          color: baseColor,
          border: "1px solid",
          borderColor: active ? "var(--border)" : "transparent",
          borderRadius: 6,
          cursor: disabled ? "default" : "pointer",
          transition: "background 0.12s, color 0.12s, border-color 0.12s",
        }}
        onMouseEnter={(e) => {
          if (disabled) return;
          e.currentTarget.style.background = hoverBg;
          e.currentTarget.style.color = hoverColor;
        }}
        onMouseLeave={(e) => {
          if (disabled) return;
          e.currentTarget.style.background = baseBg;
          e.currentTarget.style.color = baseColor;
        }}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

function ErrorBadge({ error, ignoredPrefix, ignoredSuffix }: { error: { message: string; ignoredPrefix?: string; ignoredSuffix?: string } | null; ignoredPrefix?: string; ignoredSuffix?: string }) {
  const { t } = useI18n();
  if (!error) return null;
  let tooltipText: string;
  if (error.message) {
    tooltipText = t("Parse error: {error}").replace("{error}", error.message);
  } else {
    const parts: string[] = [];
    if (ignoredPrefix) parts.push(t("Ignored prefix: {prefix}").replace("{prefix}", ignoredPrefix));
    if (ignoredSuffix) parts.push(t("Ignored suffix: {suffix}").replace("{suffix}", ignoredSuffix));
    tooltipText = parts.join("\n");
  }
  if (!tooltipText) return null;
  return (
    <Tooltip content={tooltipText}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          marginRight: 4,
          background: "rgba(248, 113, 113, 0.12)",
          color: "#f87171",
          border: "1px solid rgba(248, 113, 113, 0.3)",
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 500,
          cursor: "help",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M8 4v5" />
          <circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
        </svg>
        {t("Error")}
      </span>
    </Tooltip>
  );
}
