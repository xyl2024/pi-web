"use client";

import React, { useMemo } from "react";
import type { ReactNode } from "react";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Path segments carry type so we never confuse "0" (object key) with 0 (array index). */
export type JsonPathSeg = { kind: "key" | "index"; value: string | number };
export type JsonPath = ReadonlyArray<JsonPathSeg>;

const PATH_SEP = "";
const CHEVRON_W = 14;
const INDENT_PX = 16;

const COLOR_KEY = "var(--accent)";
const COLOR_STRING = "var(--text)";
const COLOR_NUMBER = "#d19a66";
const COLOR_BOOLEAN = "#c678dd";
const COLOR_NULL = "var(--text-dim)";
const COLOR_PUNCT = "var(--text-dim)";

export function pathKey(path: JsonPath): string {
  return path.map((p) => (p.kind === "index" ? `i${p.value}` : `k${p.value}`)).join(PATH_SEP);
}

export function parsePathKey(key: string): JsonPath {
  return key.split(PATH_SEP).map((seg) =>
    seg.startsWith("i") ? { kind: "index" as const, value: Number(seg.slice(1)) } : { kind: "key" as const, value: seg.slice(1) },
  );
}

export function getAtPath(value: unknown, path: JsonPath): { exists: boolean; container: boolean } {
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

export function collectContainerPathsAtDepth(value: unknown, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number, path: JsonPath) => {
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

export function collectAllContainerPaths(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: JsonPath) => {
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

type TextSeg = { kind: "text"; text: string; color?: string };
type ChevronSeg = { kind: "chevron"; collapsed: boolean; path: JsonPath };
type LineSeg = TextSeg | ChevronSeg;

export type JsonTreeLine = {
  depth: number;
  segs: LineSeg[];
};

function walkLines(
  value: JsonValue,
  depth: number,
  path: JsonPath,
  collapsed: Set<string>,
  emit: (line: JsonTreeLine, path: JsonPath) => void,
): void {
  if (!isContainer(value)) {
    emit({ depth, segs: primitiveSegs(value) }, path);
    return;
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
    emit({
      depth,
      segs: [
        ...(isRoot ? [] : keyPrefixSegs(parentSeg)),
        ...(isRoot ? [] : [{ kind: "text" as const, text: " ".repeat(CHEVRON_W) }]),
        { kind: "text" as const, text: open + close, color: COLOR_PUNCT },
      ],
    }, path);
    return;
  }

  if (path.length > 0 && collapsed.has(key)) {
    const label = isArray
      ? `${entries.length} ${entries.length === 1 ? "item" : "items"}`
      : `${entries.length} ${entries.length === 1 ? "key" : "keys"}`;
    emit({
      depth,
      segs: [
        ...keyPrefixSegs(parentSeg),
        { kind: "chevron", collapsed: true, path },
        { kind: "text" as const, text: open, color: COLOR_PUNCT },
        { kind: "text" as const, text: " ... ", color: COLOR_PUNCT },
        { kind: "text" as const, text: close, color: COLOR_PUNCT },
        { kind: "text" as const, text: ` ${label}`, color: "var(--text-dim)" },
      ],
    }, path);
    return;
  }

  // Open line
  emit({
    depth,
    segs: [
      ...(isRoot ? [] : keyPrefixSegs(parentSeg)),
      ...(isRoot ? [] : [{ kind: "chevron" as const, collapsed: false, path }]),
      { kind: "text" as const, text: open, color: COLOR_PUNCT },
    ],
  }, path);

  // Children
  for (const [k, v] of entries) {
    if (isContainer(v)) {
      walkLines(v, depth + 1, [...path, typeof k === "number" ? { kind: "index", value: k } : { kind: "key", value: k }], collapsed, emit);
    } else {
      emit({
        depth: depth + 1,
        segs: [
          ...(isArray ? [] : keyPrefixSegs(String(k))),
          ...primitiveSegs(v),
          ...(isArray ? [{ kind: "text" as const, text: ",", color: COLOR_PUNCT }] : []),
        ],
      }, [...path, typeof k === "number" ? { kind: "index", value: k } : { kind: "key", value: k }]);
    }
  }

  // Close line (no extra indent)
  emit({ depth, segs: [{ kind: "text" as const, text: close, color: COLOR_PUNCT }] }, path);
}

function flattenTree(value: JsonValue, depth: number, path: JsonPath, collapsed: Set<string>, out: JsonTreeLine[] = []): JsonTreeLine[] {
  walkLines(value, depth, path, collapsed, (line) => out.push(line));
  return out;
}

function keyPrefixSegs(seg: JsonPathSeg | string): LineSeg[] {
  // Array indices have no key prefix — only string object keys do.
  if (typeof seg !== "string" && seg.kind === "index") return [];
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

export type SearchMatch = {
  path: JsonPath;
  lineIndex: number;
  range: [number, number];
};

export function lineText(segs: LineSeg[]): { text: string; segOffsets: number[] } {
  const segOffsets: number[] = [];
  let text = "";
  for (let j = 0; j < segs.length; j++) {
    segOffsets.push(text.length);
    const seg = segs[j];
    if (seg.kind === "text") text += seg.text;
  }
  segOffsets.push(text.length);
  return { text, segOffsets };
}

/** Case-insensitive, non-overlapping substring matches. Empty query → null.
 *  Uses literal `indexOf` — query is NEVER treated as a regex. */
export function findMatchesInLine(text: string, query: string): Array<[number, number]> | null {
  if (query.length === 0) return null;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const out: Array<[number, number]> = [];
  let from = 0;
  while (from <= t.length - q.length) {
    const i = t.indexOf(q, from);
    if (i < 0) break;
    out.push([i, i + q.length]);
    from = i + q.length;
  }
  return out.length === 0 ? null : out;
}

/** Walks the tree ignoring collapsed state (search sees everything) and returns
 *  one SearchMatch per occurrence. lineIndex matches the renderer's line loop. */
export function findMatches(value: JsonValue, query: string): SearchMatch[] {
  if (query.length === 0) return [];
  const out: SearchMatch[] = [];
  let lineIndex = 0;
  walkLines(value, 0, [], new Set<string>(), (line, path) => {
    const { text } = lineText(line.segs);
    const ranges = findMatchesInLine(text, query);
    if (ranges) {
      for (const [s, e] of ranges) out.push({ path, lineIndex, range: [s, e] });
    }
    lineIndex++;
  });
  return out;
}

interface JsonTreeViewProps {
  value: JsonValue;
  collapsedPaths: Set<string>;
  onTogglePath: (path: JsonPath) => void;
  search?: {
    query: string;
    activeLineIndex: number;
    onLineRef?: (lineIndex: number, el: HTMLDivElement | null) => void;
  };
}

export function JsonTreeView({ value, collapsedPaths, onTogglePath, search }: JsonTreeViewProps) {
  const lines = useMemo(() => flattenTree(value, 0, [], collapsedPaths), [value, collapsedPaths]);
  return (
    <div>
      {lines.map((line, i) => {
        let text = "";
        let segOffsets: number[] = [];
        let ranges: Array<[number, number]> | null = null;
        if (search) {
          const lt = lineText(line.segs);
          text = lt.text;
          segOffsets = lt.segOffsets;
          ranges = findMatchesInLine(text, search.query);
        }
        const isActiveLine = search?.activeLineIndex === i && ranges !== null;
        const hasMatch = ranges !== null;
        return (
          <div
            key={i}
            ref={(el) => search?.onLineRef?.(i, el)}
            style={{
              paddingLeft: line.depth * INDENT_PX,
              minHeight: "1.55em",
              backgroundColor: isActiveLine ? "rgba(255, 213, 79, 0.08)" : undefined,
            }}
          >
            {line.segs.map((seg, j) => {
              if (seg.kind === "chevron") {
                return (
                  <span
                    key={j}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePath(seg.path);
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
              if (!hasMatch) {
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
              }
              // Split this text seg at match-range boundaries.
              const segStart = segOffsets[j];
              const segEnd = segOffsets[j + 1];
              const segText = seg.text;
              const pieces: ReactNode[] = [];
              let cursor = segStart;
              for (const [m0, m1] of ranges!) {
                const lo = Math.max(m0, segStart);
                const hi = Math.min(m1, segEnd);
                if (lo >= hi) continue;
                if (lo > cursor) {
                  pieces.push(
                    <span key={`p${j}-${cursor}`} style={{ color: seg.color, fontWeight: seg.color === COLOR_KEY ? 600 : undefined }}>
                      {segText.slice(cursor - segStart, lo - segStart)}
                    </span>,
                  );
                }
                pieces.push(
                  <span
                    key={`h${j}-${lo}`}
                    style={{
                      color: seg.color,
                      fontWeight: seg.color === COLOR_KEY ? 600 : undefined,
                      backgroundColor: isActiveLine ? "rgba(255, 213, 79, 0.55)" : "rgba(255, 213, 79, 0.35)",
                      borderRadius: 2,
                    }}
                  >
                    {segText.slice(lo - segStart, hi - segStart)}
                  </span>,
                );
                cursor = hi;
              }
              if (cursor < segEnd) {
                pieces.push(
                  <span key={`p${j}-${cursor}`} style={{ color: seg.color, fontWeight: seg.color === COLOR_KEY ? 600 : undefined }}>
                    {segText.slice(cursor - segStart)}
                  </span>,
                );
              }
              return <React.Fragment key={j}>{pieces}</React.Fragment>;
            })}
          </div>
        );
      })}
    </div>
  );
}
