"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { parseJsonTolerant, escapeJsonString } from "@/lib/json-parser";
import {
  JsonTreeView,
  collectAllContainerPaths,
  collectContainerPathsAtDepth,
  getAtPath,
  parsePathKey,
  pathKey,
  type JsonPath,
  type JsonValue,
} from "./JsonTreeView";

type View = "textarea" | "tree";

const DEFAULT_COLLAPSE_DEPTH = 3;
const PARSE_DEBOUNCE_MS = 250;

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
  // Minify (diagonal arrows compressing)
  minify: (
    <svg {...ICON_PROPS}>
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  ),
  // Minify & escape (scroll with text lines = JSON-as-string)
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

  useEffect(() => {
    const id = setTimeout(() => setDebouncedContent(content), PARSE_DEBOUNCE_MS);
    return () => clearTimeout(id);
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

  const handleMinify = useCallback(() => {
    if (parsed === null) return;
    setContent(JSON.stringify(parsed));
    setView("textarea");
  }, [parsed]);

  const handleEscape = useCallback(() => {
    if (parsed === null) return;
    setContent(escapeJsonString(parsed));
    setView("textarea");
  }, [parsed]);

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

  const handleCopy = useCallback(async () => {
    if (content.length === 0) return;
    try {
      await navigator.clipboard.writeText(content);
      toast.show({ kind: "success", message: t("Copied") });
    } catch {
      toast.show({ kind: "error", message: t("Failed to copy") });
    }
  }, [content, t, toast]);

  const isTreeView = view === "tree";
  const disableTransform = parsed === null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={toolbarStyle}>
        {!isTreeView && (
          <>
            <IconButton label={t("Minify")} icon={ICONS.minify} onClick={handleMinify} disabled={disableTransform} />
            <IconButton label={t("Minify & escape")} icon={ICONS.escape} onClick={handleEscape} disabled={disableTransform} />
            <div style={toolbarDividerStyle} />
          </>
        )}
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
        <IconButton label={t("Copy")} icon={ICONS.copy} onClick={handleCopy} disabled={content.length === 0} />
      </div>

      {isTreeView ? (
        <div style={viewerStyle}>
          {parsed ? (
            <JsonTreeView value={parsed} collapsedPaths={collapsedPaths} onTogglePath={togglePath} />
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
