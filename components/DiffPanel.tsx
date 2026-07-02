"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { diffLines, diffWords, type Change } from "diff";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";

const STATE_STORAGE_KEY = "pi-diff-state";

type ViewMode = "unified" | "split";

interface PersistedState {
  before?: string;
  after?: string;
  viewMode?: ViewMode;
}

interface Row {
  kind: "unchanged" | "removed" | "added" | "changed";
  oldLineNo: number | null;
  newLineNo: number | null;
  oldLine: string | null;
  newLine: string | null;
  // Word-level diff for "changed" rows — produced by diffWords(oldLine, newLine).
  // `added` chunks only appear on the right side; `removed` only on the left.
  wordDiff?: Change[];
}

// Split a diff segment into actual lines. diffLines always appends a trailing
// "\n", so splitting on "\n" yields an empty trailing element that we drop.
function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Walk the line-level diff and produce one Row per display line. Consecutive
// removed+added segments are paired so we can run a word-level diff inside the
// pair and highlight only the words that actually changed.
function preprocessRows(changes: Change[]): Row[] {
  const rows: Row[] = [];
  let oldLineNo = 1;
  let newLineNo = 1;

  let i = 0;
  while (i < changes.length) {
    const c = changes[i];

    if (c.removed) {
      const removedLines = splitLines(c.value);
      const next = changes[i + 1];
      if (next && next.added) {
        // Pair: removed followed by added. Align the shorter side with empty
        // lines on the longer side so the row grid stays rectangular.
        const addedLines = splitLines(next.value);
        const pairCount = Math.max(removedLines.length, addedLines.length);
        for (let j = 0; j < pairCount; j++) {
          const oldLine = removedLines[j] ?? null;
          const newLine = addedLines[j] ?? null;
          if (oldLine !== null && newLine !== null) {
            rows.push({
              kind: "changed",
              oldLineNo: oldLineNo++,
              newLineNo: newLineNo++,
              oldLine,
              newLine,
              wordDiff: diffWords(oldLine, newLine),
            });
          } else if (oldLine !== null) {
            rows.push({
              kind: "removed",
              oldLineNo: oldLineNo++,
              newLineNo: null,
              oldLine,
              newLine: null,
            });
          } else if (newLine !== null) {
            rows.push({
              kind: "added",
              oldLineNo: null,
              newLineNo: newLineNo++,
              oldLine: null,
              newLine,
            });
          }
        }
        i += 2;
      } else {
        for (const line of removedLines) {
          rows.push({
            kind: "removed",
            oldLineNo: oldLineNo++,
            newLineNo: null,
            oldLine: line,
            newLine: null,
          });
        }
        i++;
      }
    } else if (c.added) {
      for (const line of splitLines(c.value)) {
        rows.push({
          kind: "added",
          oldLineNo: null,
          newLineNo: newLineNo++,
          oldLine: null,
          newLine: line,
        });
      }
      i++;
    } else {
      for (const line of splitLines(c.value)) {
        rows.push({
          kind: "unchanged",
          oldLineNo: oldLineNo++,
          newLineNo: newLineNo++,
          oldLine: line,
          newLine: line,
        });
      }
      i++;
    }
  }

  return rows;
}

// Render the left or right side of a changed-row word diff. Each chunk is
// either common (both sides), removed (only left), or added (only right).
function renderWordSpans(chunks: Change[], side: "left" | "right") {
  return chunks.map((chunk, idx) => {
    if (chunk.added) {
      return side === "right" ? (
        <span key={idx} style={{ background: "var(--diff-added-strong)" }}>
          {chunk.value}
        </span>
      ) : null;
    }
    if (chunk.removed) {
      return side === "left" ? (
        <span key={idx} style={{ background: "var(--diff-removed-strong)" }}>
          {chunk.value}
        </span>
      ) : null;
    }
    return <span key={idx}>{chunk.value}</span>;
  });
}

export function DiffPanel() {
  const { t } = useI18n();
  const toast = useToast();

  const [before, setBefore] = useState("");
  const [after, setAfter] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("unified");
  const [modalOpen, setModalOpen] = useState(false);

  const initializedRef = useRef(false);

  // Restore from localStorage. The "initialized" gate below prevents the save
  // effect from clobbering the stored value with empty defaults on first run.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STATE_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as PersistedState;
      if (typeof data?.before === "string") setBefore(data.before);
      if (typeof data?.after === "string") setAfter(data.after);
      if (data?.viewMode === "unified" || data?.viewMode === "split") setViewMode(data.viewMode);
    } catch { /* malformed JSON or localStorage unavailable — ignore */ }
  }, []);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }
    try {
      const payload: PersistedState = { before, after, viewMode };
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(payload));
    } catch { /* quota exceeded or localStorage unavailable — ignore */ }
  }, [before, after, viewMode]);

  const lineChanges = useMemo(() => diffLines(before, after), [before, after]);

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const c of lineChanges) {
      const n = c.count ?? splitLines(c.value).length;
      if (c.added) added += n;
      else if (c.removed) removed += n;
    }
    return { added, removed };
  }, [lineChanges]);

  const rows = useMemo(() => preprocessRows(lineChanges), [lineChanges]);

  const handleSwap = useCallback(() => {
    setBefore(after);
    setAfter(before);
  }, [before, after]);

  const isEmpty = before === "" && after === "";
  const hasChanges = stats.added > 0 || stats.removed > 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg)",
        overflow: "hidden",
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
          flexShrink: 0,
          minHeight: 36,
        }}
      >
        <Tooltip content={isEmpty ? t("Edit") : t("Edit")}>
          <button
            onClick={() => setModalOpen(true)}
            style={{
              padding: "4px 10px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("Edit")}
          </button>
        </Tooltip>

        <div
          style={{
            display: "flex",
            border: "1px solid var(--border)",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <ViewModeButton active={viewMode === "unified"} onClick={() => setViewMode("unified")}>
            {t("Unified")}
          </ViewModeButton>
          <ViewModeButton active={viewMode === "split"} onClick={() => setViewMode("split")}>
            {t("Side by side")}
          </ViewModeButton>
        </div>

        <Tooltip content={t("Swap")}>
          <button
            onClick={handleSwap}
            disabled={isEmpty}
            style={{
              padding: "4px 10px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: isEmpty ? "var(--text-dim)" : "var(--text)",
              cursor: isEmpty ? "not-allowed" : "pointer",
              fontSize: 12,
              opacity: isEmpty ? 0.6 : 1,
            }}
          >
            {t("Swap")}
          </button>
        </Tooltip>

        <div style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {hasChanges ? (
            <>
              <span style={{ color: "#1a7f37", fontWeight: 700 }}>+{stats.added}</span>
              {" / "}
              <span style={{ color: "#cf222e", fontWeight: 700 }}>-{stats.removed}</span>
            </>
          ) : !isEmpty ? (
            <span>{t("No changes")}</span>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.55,
        }}
      >
        {isEmpty ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-dim)",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
            }}
          >
            {t("Click Edit to enter text")}
          </div>
        ) : !hasChanges ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-dim)",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
            }}
          >
            {t("No changes")}
          </div>
        ) : viewMode === "unified" ? (
          <UnifiedView rows={rows} />
        ) : (
          <SplitView rows={rows} />
        )}
      </div>

      {modalOpen && (
        <DiffPanelModal
          before={before}
          after={after}
          onBeforeChange={setBefore}
          onAfterChange={setAfter}
          onClose={() => setModalOpen(false)}
          onToast={(kind, message) => toast.show({ kind, message })}
          t={t}
        />
      )}
    </div>
  );
}

function ViewModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 10px",
        background: active ? "var(--bg-selected)" : "transparent",
        border: "none",
        color: active ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer",
        fontSize: 12,
      }}
    >
      {children}
    </button>
  );
}

// Shared style helpers for diff rows.
const GUTTER_WIDTH = 44;
const ROW_BASE: React.CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  minHeight: 20,
  // Row width follows content so the row's background covers the entire line
  // — including the part that lives past the horizontal scroll viewport.
  minWidth: "max-content",
};

function GutterCell({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      style={{
        flexShrink: 0,
        width: GUTTER_WIDTH,
        padding: "0 6px",
        textAlign: "right",
        color: color ?? "var(--diff-line-number)",
        userSelect: "none",
        background: "transparent",
        borderRight: "1px solid var(--border)",
        fontSize: 11,
      }}
    >
      {children}
    </span>
  );
}

function UnifiedView({ rows }: { rows: Row[] }) {
  return (
    <div>
      {rows.map((row, idx) => {
        if (row.kind === "changed") {
          return (
            <RowPairUnified
              key={idx}
              oldNo={row.oldLineNo!}
              newNo={row.newLineNo!}
              wordDiff={row.wordDiff!}
            />
          );
        }
        if (row.kind === "removed") {
          return <RowSingle key={idx} marker="-" bg="var(--diff-removed-bg)" lineNo={row.oldLineNo!} line={row.oldLine!} />;
        }
        if (row.kind === "added") {
          return <RowSingle key={idx} marker="+" bg="var(--diff-added-bg)" lineNo={row.newLineNo!} line={row.newLine!} />;
        }
        return <RowSingle key={idx} marker=" " bg="transparent" lineNo={row.oldLineNo!} line={row.oldLine!} />;
      })}
    </div>
  );
}

function SplitView({ rows }: { rows: Row[] }) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", minHeight: 0 }}>
      <SplitColumn side="left" rows={rows} />
      <SplitColumn side="right" rows={rows} />
    </div>
  );
}

// One column of the side-by-side view. Each column is its own horizontal
// scroll container so scrolling the left side never moves the right (and vice
// versa). Vertical scroll is delegated to the body container above.
function SplitColumn({ side, rows }: { side: "left" | "right"; rows: Row[] }) {
  return (
    <div
      style={{
        flex: 1,
        overflowX: "auto",
        overflowY: "hidden",
        minWidth: 0,
        ...(side === "right" ? { borderLeft: "1px solid var(--border)" } : {}),
      }}
    >
      {rows.map((row, idx) => (
        <SplitRow key={idx} side={side} row={row} />
      ))}
    </div>
  );
}

// One row inside a split column. The gutter is `position: sticky; left: 0` so
// the line number stays anchored to the column's left edge while content
// scrolls horizontally behind it.
function SplitRow({ side, row }: { side: "left" | "right"; row: Row }) {
  const showLine = side === "left" ? row.oldLine : row.newLine;
  const showNo = side === "left" ? row.oldLineNo : row.newLineNo;
  const bg =
    row.kind === "changed"
      ? side === "left"
        ? "var(--diff-removed-bg)"
        : "var(--diff-added-bg)"
      : row.kind === "removed" && side === "left"
        ? "var(--diff-removed-bg)"
        : row.kind === "added" && side === "right"
          ? "var(--diff-added-bg)"
          : "transparent";
  const hasChange = row.kind === "changed" && !!row.wordDiff;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        minHeight: 20,
        background: bg,
        // Row width follows content so the background covers the entire line —
        // including the part that lives past the column's horizontal scroll viewport.
        minWidth: "max-content",
      }}
    >
      <span
        style={{
          flexShrink: 0,
          width: GUTTER_WIDTH,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--diff-line-number)",
          userSelect: "none",
          background: bg,
          borderRight: "1px solid var(--border)",
          fontSize: 11,
          position: "sticky",
          left: 0,
          zIndex: 1,
        }}
      >
        {showNo ?? ""}
      </span>
      <span style={{ padding: "0 8px", whiteSpace: "pre", minWidth: "max-content", color: "var(--text)" }}>
        {showLine !== null && showLine !== undefined
          ? hasChange
            ? renderWordSpans(row.wordDiff!, side)
            : showLine || " "
          : " "}
      </span>
    </div>
  );
}

// One side of a unified diff row. Renders line number + marker + content.
// `bg` is the row's background color (transparent for unchanged).
function RowSingle({
  marker,
  bg,
  lineNo,
  line,
}: {
  marker: "-" | "+" | " ";
  bg: string;
  lineNo: number;
  line: string;
}) {
  return (
    <div style={{ ...ROW_BASE, background: bg }}>
      <span
        style={{
          flexShrink: 0,
          width: 24,
          padding: "0 4px",
          textAlign: "center",
          color: "var(--text-dim)",
          userSelect: "none",
          fontSize: 11,
        }}
      >
        {marker}
      </span>
      <GutterCell>{lineNo}</GutterCell>
      <span style={{ padding: "0 8px", whiteSpace: "pre", flex: 1, minWidth: "max-content", color: "var(--text)" }}>
        {line || " "}
      </span>
    </div>
  );
}

// Unified changed-row: stacked left (removed) and right (added) on top of each
// other. Both share the old line number on the left gutter and new on the
// right; word-level highlights paint the modified words.
function RowPairUnified({
  oldNo,
  newNo,
  wordDiff,
}: {
  oldNo: number;
  newNo: number;
  wordDiff: Change[];
}) {
  return (
    <>
      <div style={{ ...ROW_BASE, background: "var(--diff-removed-bg)" }}>
        <span style={{ flexShrink: 0, width: 24, textAlign: "center", color: "var(--text-dim)", userSelect: "none", fontSize: 11 }}>-</span>
        <GutterCell>{oldNo}</GutterCell>
        <span style={{ padding: "0 8px", whiteSpace: "pre", flex: 1, minWidth: "max-content", color: "var(--text)" }}>
          {renderWordSpans(wordDiff, "left")}
        </span>
      </div>
      <div style={{ ...ROW_BASE, background: "var(--diff-added-bg)" }}>
        <span style={{ flexShrink: 0, width: 24, textAlign: "center", color: "var(--text-dim)", userSelect: "none", fontSize: 11 }}>+</span>
        <GutterCell>{newNo}</GutterCell>
        <span style={{ padding: "0 8px", whiteSpace: "pre", flex: 1, minWidth: "max-content", color: "var(--text)" }}>
          {renderWordSpans(wordDiff, "right")}
        </span>
      </div>
    </>
  );
}

// Modal: enter / edit before/after text and optionally load from file.
function DiffPanelModal({
  before,
  after,
  onBeforeChange,
  onAfterChange,
  onClose,
  onToast,
  t,
}: {
  before: string;
  after: string;
  onBeforeChange: (s: string) => void;
  onAfterChange: (s: string) => void;
  onClose: () => void;
  onToast: (kind: "success" | "error" | "info", message: string) => void;
  t: (key: string) => string;
}) {
  // Local draft so the user can cancel without touching the panel state.
  const [draftBefore, setDraftBefore] = useState(before);
  const [draftAfter, setDraftAfter] = useState(after);
  const [loadTarget, setLoadTarget] = useState<"before" | "after" | null>(null);
  const [loadPath, setLoadPath] = useState("");
  const [loading, setLoading] = useState(false);

  // Portal target. Mount after first client render to avoid SSR mismatch.
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalEl(document.body);
  }, []);

  useEffect(() => {
    if (!portalEl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [portalEl, onClose]);

  const loadFromFile = useCallback(async () => {
    if (!loadTarget) return;
    const path = loadPath.trim();
    if (!path) {
      onToast("error", t("File path is required"));
      return;
    }
    setLoading(true);
    try {
      // The file API path segment needs URI-encoded absolute path. Encoding
      // each path component separately preserves "/" between components.
      const encoded = path
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      const res = await fetch(`/api/files/${encoded}?type=read`);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(errText || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { content?: string; error?: string };
      if (data.error || typeof data.content !== "string") {
        throw new Error(data.error ?? "Invalid response");
      }
      if (loadTarget === "before") setDraftBefore(data.content);
      else setDraftAfter(data.content);
      onToast("success", t("Loaded"));
      setLoadTarget(null);
      setLoadPath("");
    } catch (e) {
      onToast("error", e instanceof Error && e.message ? e.message : t("Failed to load file"));
    } finally {
      setLoading(false);
    }
  }, [loadTarget, loadPath, onToast, t]);

  if (!portalEl) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 20,
          width: "min(640px, 100%)",
          maxHeight: "calc(100vh - 32px)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
          {t("Compare")}
        </div>

        <TextareaSection
          label={t("Before")}
          value={draftBefore}
          onChange={setDraftBefore}
          loadTarget="before"
          activeLoadTarget={loadTarget}
          loadPath={loadPath}
          onLoadPathChange={setLoadPath}
          onLoadTargetChange={setLoadTarget}
          onLoadFile={loadFromFile}
          loading={loading}
          t={t}
        />

        <TextareaSection
          label={t("After")}
          value={draftAfter}
          onChange={setDraftAfter}
          loadTarget="after"
          activeLoadTarget={loadTarget}
          loadPath={loadPath}
          onLoadPathChange={setLoadPath}
          onLoadTargetChange={setLoadTarget}
          onLoadFile={loadFromFile}
          loading={loading}
          t={t}
        />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            onClick={onClose}
            style={{
              padding: "6px 14px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("Cancel")}
          </button>
          <button
            autoFocus
            onClick={() => {
              onBeforeChange(draftBefore);
              onAfterChange(draftAfter);
              onClose();
            }}
            style={{
              padding: "6px 14px",
              background: "var(--accent)",
              border: "1px solid var(--accent)",
              borderRadius: 4,
              color: "var(--bg)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {t("Compare")}
          </button>
        </div>
      </div>
    </div>,
    portalEl,
  );
}

function TextareaSection({
  label,
  value,
  onChange,
  loadTarget,
  activeLoadTarget,
  loadPath,
  onLoadPathChange,
  onLoadTargetChange,
  onLoadFile,
  loading,
  t,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  loadTarget: "before" | "after";
  activeLoadTarget: "before" | "after" | null;
  loadPath: string;
  onLoadPathChange: (s: string) => void;
  onLoadTargetChange: (t: "before" | "after" | null) => void;
  onLoadFile: () => void;
  loading: boolean;
  t: (key: string) => string;
}) {
  const isActive = activeLoadTarget === loadTarget;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{label}</span>
        <button
          onClick={() => {
            if (isActive) {
              onLoadTargetChange(null);
              onLoadPathChange("");
            } else {
              onLoadTargetChange(loadTarget);
            }
          }}
          style={{
            padding: "2px 8px",
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 3,
            color: isActive ? "var(--accent)" : "var(--text-muted)",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {t("Load from file")}
        </button>
      </div>
      {isActive && (
        <div style={{ display: "flex", gap: 4 }}>
          <input
            type="text"
            value={loadPath}
            onChange={(e) => onLoadPathChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onLoadFile();
              }
            }}
            placeholder={t("File path")}
            autoFocus
            style={{
              flex: 1,
              padding: "4px 8px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              outline: "none",
            }}
          />
          <button
            onClick={onLoadFile}
            disabled={loading}
            style={{
              padding: "4px 12px",
              background: "var(--accent)",
              border: "1px solid var(--accent)",
              borderRadius: 3,
              color: "var(--bg)",
              cursor: loading ? "not-allowed" : "pointer",
              fontSize: 12,
              opacity: loading ? 0.6 : 1,
            }}
          >
            {t("Load")}
          </button>
        </div>
      )}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: 140,
          padding: 8,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.5,
          resize: "vertical",
          outline: "none",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}