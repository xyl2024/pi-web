"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { parseJsonTolerant, minifyJson, escapeJsonString } from "@/lib/json-parser";

type Mode = "format" | "minify" | "escape";
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Path segments carry type so we never confuse "0" (object key) with 0 (array index). */
type PathSeg = { kind: "key" | "index"; value: string | number };
type Path = ReadonlyArray<PathSeg>;

const DEFAULT_COLLAPSE_DEPTH = 3;
const PARSE_DEBOUNCE_MS = 250;
const PATH_SEP = "";
const INDENT_PX = 16;

function pathKey(path: Path): string {
  return path.map((p) => (p.kind === "index" ? `i${p.value}` : `k${p.value}`)).join(PATH_SEP);
}

function getAtPath(value: unknown, path: Path): { exists: boolean; container: boolean } {
  let v: unknown = value;
  for (const seg of path) {
    if (v == null || typeof v !== "object") return { exists: false, container: false };
    if (Array.isArray(v)) {
      if (seg.kind !== "index") return { exists: false, container: false };
      v = v[seg.value as number];
    } else {
      if (seg.kind !== "key") return { exists: false, container: false };
      v = (v as Record<string, unknown>)[seg.value as string];
    }
  }
  if (v === undefined) return { exists: false, container: false };
  return { exists: true, container: v !== null && typeof v === "object" };
}

function collectContainerPathsAtDepth(value: unknown, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number, path: Path) => {
    if (v == null || typeof v !== "object") return;
    if (depth >= maxDepth) {
      out.push(pathKey(path));
      return;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], depth + 1, [...path, { kind: "index", value: i }]);
    } else {
      for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], depth + 1, [...path, { kind: "key", value: k }]);
    }
  };
  walk(value, 0, []);
  return out;
}

function collectAllContainerPaths(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: Path) => {
    if (v == null || typeof v !== "object") return;
    if (path.length > 0) out.push(pathKey(path));
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], [...path, { kind: "index", value: i }]);
    } else {
      for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], [...path, { kind: "key", value: k }]);
    }
  };
  walk(value, []);
  return out;
}

function isContainer(v: unknown): v is JsonValue[] | { [k: string]: JsonValue } {
  return v != null && typeof v === "object";
}

function parsePathKey(key: string): Path {
  return key.split(PATH_SEP).map((seg) =>
    seg.startsWith("i") ? { kind: "index" as const, value: Number(seg.slice(1)) } : { kind: "key" as const, value: seg.slice(1) },
  );
}

export function JsonPanel() {
  const { t } = useI18n();
  const toast = useToast();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("format");
  const [debouncedInput, setDebouncedInput] = useState("");
  const [error, setError] = useState<{ message: string; ignoredPrefix?: string; ignoredSuffix?: string } | null>(null);
  const [parsed, setParsed] = useState<JsonValue | null>(null);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const initializedRef = useRef(false);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedInput(input), PARSE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [input]);

  useEffect(() => {
    if (debouncedInput.length === 0) {
      setError(null);
      return;
    }
    const result = parseJsonTolerant(debouncedInput);
    if (!result.ok) {
      setError({ message: result.error });
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
  }, [debouncedInput]);

  const handleCollapseAll = useCallback(() => {
    if (!parsed) return;
    setCollapsedPaths(new Set(collectAllContainerPaths(parsed)));
  }, [parsed]);

  const handleExpandAll = useCallback(() => setCollapsedPaths(new Set()), []);

  const togglePath = useCallback((path: Path) => {
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

  const isFormat = mode === "format";
  const minifiedView = useMemo(() => (parsed ? minifyJson(parsed) : ""), [parsed]);
  const escapedView = useMemo(() => (parsed ? escapeJsonString(parsed) : ""), [parsed]);
  const treeLines = useMemo(
    () => (parsed ? flattenTree(parsed, 0, [], collapsedPaths) : []),
    [parsed, collapsedPaths],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: "0 0 14.2857%", minHeight: 0, display: "flex", flexDirection: "column", borderBottom: "1px solid var(--border)" }}>
        <div style={inputHeaderStyle}>
          {t("JSON input")}
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("Paste JSON here…")}
          spellCheck={false}
          style={textareaStyle}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={toolbarStyle}>
          <ToolbarButton label={t("Format")} active={mode === "format"} onClick={() => setMode("format")} />
          <ToolbarButton label={t("Minify")} active={mode === "minify"} onClick={() => setMode("minify")} />
          <ToolbarButton label={t("Minify & escape")} active={mode === "escape"} onClick={() => setMode("escape")} />
          <div style={toolbarDividerStyle} />
          <ToolbarButton label={t("Collapse all")} onClick={handleCollapseAll} disabled={!parsed || !isFormat} />
          <ToolbarButton label={t("Expand all")} onClick={handleExpandAll} disabled={!parsed || !isFormat} />
          <div style={{ flex: 1 }} />
          <ErrorBadge error={error} ignoredPrefix={error?.ignoredPrefix} ignoredSuffix={error?.ignoredSuffix} />
          <ToolbarButton label={t("Copy")} onClick={handleCopy} disabled={!parsed} />
        </div>

        <div style={viewerStyle}>
          {!parsed && !error ? (
            <div style={{ color: "var(--text-dim)", fontStyle: "italic", whiteSpace: "normal" }}>{t("Paste JSON above to format")}</div>
          ) : error && !parsed ? (
            <div style={{ color: "#f87171", whiteSpace: "pre-wrap" }}>{t("Parse error: {error}").replace("{error}", error.message)}</div>
          ) : mode === "format" && parsed ? (
            <TreeView lines={treeLines} onToggle={togglePath} />
          ) : mode === "minify" && parsed ? (
            <span>{minifiedView}</span>
          ) : (
            <span>{escapedView}</span>
          )}
        </div>
      </div>
    </div>
  );
}

const inputHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "6px 12px",
  fontSize: 11,
  color: "var(--text-dim)",
  background: "var(--bg-panel)",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

const textareaStyle: React.CSSProperties = {
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

// ── Tree view: flat-line rendering ────────────────────────────────────────

const COLOR_KEY = "var(--accent)";
const COLOR_STRING = "#000000";
const COLOR_NUMBER = "#d19a66";
const COLOR_BOOLEAN = "#c678dd";
const COLOR_NULL = "var(--text-dim)";
const COLOR_PUNCT = "var(--text-dim)";

const CHEVRON_W = 14;

type TextSeg = { kind: "text"; text: string; color?: string };
type ChevronSeg = { kind: "chevron"; collapsed: boolean; togglePath: Path };
type LineSeg = TextSeg | ChevronSeg;

type TreeLine = {
  depth: number;
  segs: LineSeg[];
  togglePath?: Path;
  collapsed?: boolean;
};

function flattenTree(value: JsonValue, depth: number, path: Path, collapsed: Set<string>, out: TreeLine[] = []): TreeLine[] {
  if (!isContainer(value)) {
    out.push({ depth, segs: primitiveSegs(value) });
    return out;
  }
  const isArray = Array.isArray(value);
  const open = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";
  const entries: Array<[string | number, JsonValue]> = isArray
    ? (value as JsonValue[]).map((v, i) => [i, v])
    : Object.entries(value as { [k: string]: JsonValue });
  const key = pathKey(path);
  const isRoot = path.length === 0;
  const parentSeg = path[path.length - 1];

  if (entries.length === 0) {
    out.push({
      depth,
      segs: [
        ...(isRoot ? [] : keyPrefixSegs(parentSeg, isArray)),
        ...(isRoot ? [] : [{ kind: "text" as const, text: " ".repeat(CHEVRON_W) }]),
        { kind: "text" as const, text: open + close, color: COLOR_PUNCT },
      ],
    });
    return out;
  }

  if (path.length > 0 && collapsed.has(key)) {
    const label = isArray
      ? `${entries.length} ${entries.length === 1 ? "item" : "items"}`
      : `${entries.length} ${entries.length === 1 ? "key" : "keys"}`;
    out.push({
      depth,
      togglePath: path,
      collapsed: true,
      segs: [
        ...keyPrefixSegs(parentSeg, isArray),
        { kind: "chevron", collapsed: true, togglePath: path },
        { kind: "text" as const, text: open, color: COLOR_PUNCT },
        { kind: "text" as const, text: " ... ", color: COLOR_PUNCT },
        { kind: "text" as const, text: close, color: COLOR_PUNCT },
        { kind: "text" as const, text: ` ${label}`, color: "var(--text-dim)" },
      ],
    });
    return out;
  }

  // Open line
  out.push({
    depth,
    segs: [
      ...(isRoot ? [] : keyPrefixSegs(parentSeg, isArray)),
      ...(isRoot ? [] : [{ kind: "chevron" as const, collapsed: false, togglePath: path }]),
      { kind: "text" as const, text: open, color: COLOR_PUNCT },
    ],
  });

  // Children
  for (const [k, v] of entries) {
    if (isContainer(v)) {
      flattenTree(v, depth + 1, [...path, typeof k === "number" ? { kind: "index", value: k } : { kind: "key", value: k }], collapsed, out);
    } else {
      out.push({
        depth: depth + 1,
        segs: [
          ...(isArray ? [] : keyPrefixSegs(String(k), false)),
          ...primitiveSegs(v),
          ...(isArray ? [{ kind: "text" as const, text: ",", color: COLOR_PUNCT }] : []),
        ],
      });
    }
  }

  // Close line (no extra indent)
  out.push({ depth, segs: [{ kind: "text" as const, text: close, color: COLOR_PUNCT }] });
  return out;
}

function keyPrefixSegs(seg: PathSeg | string, isArrayItem: boolean): LineSeg[] {
  if (isArrayItem) return [];
  const keyStr = typeof seg === "string" ? seg : String(seg.value);
  return [
    { kind: "text" as const, text: '"', color: COLOR_PUNCT },
    { kind: "text" as const, text: keyStr, color: COLOR_KEY },
    { kind: "text" as const, text: '"', color: COLOR_PUNCT },
    { kind: "text" as const, text: ": ", color: COLOR_PUNCT },
  ];
}

function primitiveSegs(v: JsonValue): TextSeg[] {
  if (v === null) return [{ kind: "text" as const, text: "null", color: COLOR_NULL }];
  switch (typeof v) {
    case "string":
      return [{ kind: "text" as const, text: `"${escapeString(v)}"`, color: COLOR_STRING }];
    case "number":
      return [{ kind: "text" as const, text: String(v), color: COLOR_NUMBER }];
    case "boolean":
      return [{ kind: "text" as const, text: String(v), color: COLOR_BOOLEAN }];
    default:
      return [{ kind: "text" as const, text: String(v) }];
  }
}

function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function TreeView({ lines, onToggle }: { lines: TreeLine[]; onToggle: (path: Path) => void }) {
  return (
    <div>
      {lines.map((line, i) => (
        <div
          key={i}
          style={{ paddingLeft: line.depth * INDENT_PX, minHeight: "1.55em" }}
        >
          {line.segs.map((seg, j) => {
            if ("kind" in seg && seg.kind === "chevron") {
              return (
                <span
                  key={j}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(seg.togglePath);
                  }}
                  style={{
                    display: "inline-block",
                    width: CHEVRON_W,
                    textAlign: "center",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  role="button"
                  aria-label={seg.collapsed ? "expand" : "collapse"}
                >
                  {seg.collapsed ? "▶" : "▼"}
                </span>
              );
            }
            return (
              <span
                key={j}
                style={{
                  color: seg.color,
                  fontWeight: seg.color === COLOR_KEY ? 600 : undefined,
                }}
              >
                {seg.text}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
