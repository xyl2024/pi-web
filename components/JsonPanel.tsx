"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { parseJsonTolerant, minifyJson, escapeJsonString } from "@/lib/json-parser";
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

  const handleFormat = useCallback(() => {
    if (parsed === null) return;
    setContent(JSON.stringify(parsed, null, 2));
    setView("textarea");
  }, [parsed]);

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
    if (!parsed) return;
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
    if (!parsed) return;
    try {
      await navigator.clipboard.writeText(minifyJson(parsed));
      toast.show({ kind: "success", message: t("Copied") });
    } catch {
      toast.show({ kind: "error", message: t("Failed to copy") });
    }
  }, [parsed, t, toast]);

  const isTreeView = view === "tree";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={toolbarStyle}>
        {!isTreeView && (
          <>
            <ToolbarButton label={t("Format")} onClick={handleFormat} disabled={parsed === null} />
            <ToolbarButton label={t("Minify")} onClick={handleMinify} disabled={parsed === null} />
            <ToolbarButton label={t("Minify & escape")} onClick={handleEscape} disabled={parsed === null} />
            <div style={toolbarDividerStyle} />
          </>
        )}
        <ToolbarButton label={t("Tree view")} active={isTreeView} onClick={handleToggleTree} disabled={parsed === null} />
        {isTreeView && (
          <>
            <div style={toolbarDividerStyle} />
            <ToolbarButton label={t("Collapse all")} onClick={handleCollapseAll} disabled={!parsed || !isTreeView} />
            <ToolbarButton label={t("Expand all")} onClick={handleExpandAll} disabled={!parsed || !isTreeView} />
          </>
        )}
        <div style={{ flex: 1 }} />
        <ErrorBadge error={error} ignoredPrefix={error?.ignoredPrefix} ignoredSuffix={error?.ignoredSuffix} />
        <ToolbarButton label={t("Copy")} onClick={handleCopy} disabled={!parsed} />
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

function ToolbarButton({ label, active, onClick, disabled }: { label: string; active?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "4px 10px",
        background: active ? "var(--bg)" : "transparent",
        color: disabled ? "var(--text-dim)" : active ? "var(--text)" : "var(--text-muted)",
        border: "1px solid",
        borderColor: active ? "var(--border)" : "transparent",
        borderRadius: 4,
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        cursor: disabled ? "default" : "pointer",
        transition: "background 0.1s, color 0.1s",
      }}
    >
      {label}
    </button>
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
