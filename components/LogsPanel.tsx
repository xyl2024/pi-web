"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import {
  useLogsState,
  appendLogEntry,
  clearLogs,
  entryMatchesFilters,
  getEntrySessionId,
  LOG_RING_CAPACITY,
  setLogEntries,
  setLogsConnected,
  setLogsPaused,
  setLogsQuery,
  setLogsScopes,
  setLogsSessionId,
  toggleLevel,
  ALL_LEVELS,
  type LogEntry,
  type LogLevel,
} from "@/hooks/logsStore";

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "var(--text-dim)",
  info: "var(--text-muted)",
  warn: "#f59e0b",
  error: "#ef4444",
};

const LEVEL_BG: Record<LogLevel, string> = {
  debug: "transparent",
  info: "transparent",
  warn: "rgba(245, 158, 11, 0.08)",
  error: "rgba(239, 68, 68, 0.10)",
};

/** Format an ISO timestamp as HH:MM:SS.mmm (local time). */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function LogsPanel() {
  const { t } = useI18n();
  const toast = useToast();
  const state = useLogsState();

  const listRef = useRef<HTMLDivElement | null>(null);
  // True after the user has scrolled away from the bottom — auto-scroll
  // is suppressed until they scroll back, so reading older entries isn't
  // interrupted by new lines arriving.
  const pinnedToBottomRef = useRef<boolean>(true);

  // ── SSE lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource("/api/logs/events");

    const onOpen = () => setLogsConnected(true);
    const onSnapshot = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { entries: LogEntry[] };
        setLogEntries(data.entries);
      } catch {
        // Server might have sent a partial frame — ignore.
      }
    };
    const onEntry = (ev: MessageEvent) => {
      try {
        const entry = JSON.parse(ev.data) as LogEntry;
        appendLogEntry(entry);
      } catch {
        /* ignore malformed frame */
      }
    };
    const onError = () => setLogsConnected(false);

    es.addEventListener("open", onOpen);
    es.addEventListener("snapshot", onSnapshot);
    es.addEventListener("entry", onEntry);
    es.addEventListener("error", onError);

    return () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("snapshot", onSnapshot);
      es.removeEventListener("entry", onEntry);
      es.removeEventListener("error", onError);
      es.close();
      setLogsConnected(false);
    };
  }, []);

  // ── Auto-scroll to bottom on new entries, unless user has scrolled away ─
  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < 50;
  }, []);

  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.entries]);

  // ── Derived: dropdown options drawn from the current entry set ─────────
  const availableScopes = useMemo(() => {
    const set = new Set<string>();
    for (const e of state.entries) set.add(e.scope);
    return Array.from(set).sort();
  }, [state.entries]);

  const availableSessionIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of state.entries) {
      const sid = getEntrySessionId(e);
      if (sid) set.add(sid);
    }
    return Array.from(set).sort();
  }, [state.entries]);

  // If the currently-selected scope / sessionId is no longer in the entry
  // set (e.g. after Clear), reset the filter so the user isn't left with an
  // empty list and no UI feedback about why.
  useEffect(() => {
    const f = state.filters;
    if (f.scopes.length > 0 && f.scopes.every((s) => !availableScopes.includes(s))) {
      setLogsScopes([]);
    }
    if (f.sessionId && !availableSessionIds.includes(f.sessionId)) {
      setLogsSessionId(null);
    }
  }, [availableScopes, availableSessionIds, state.filters]);

  const visibleEntries = useMemo(() => {
    return state.entries.filter((e) => entryMatchesFilters(e, state.filters));
  }, [state.entries, state.filters]);

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    if (state.entries.length === 0) return;
    clearLogs();
    toast.show({ kind: "success", message: t("Logs cleared") });
  }, [state.entries.length, toast, t]);

  const handleTogglePause = useCallback(() => {
    setLogsPaused(!state.paused);
  }, [state.paused]);

  const handleCopyAll = useCallback(async () => {
    const text = visibleEntries
      .map((e) => `[${e.ts}] [${e.level.toUpperCase()}] [${e.scope}] ${e.message}${e.fieldsJson ? " " + e.fieldsJson : ""}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ kind: "success", message: t("Copied") });
    } catch {
      toast.show({ kind: "error", message: t("Failed to copy") });
    }
  }, [visibleEntries, toast, t]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)" }}>
      <Toolbar
        paused={state.paused}
        onTogglePause={handleTogglePause}
        droppedWhilePaused={state.droppedWhilePaused}
        connected={state.connected}
        showing={visibleEntries.length}
        capacity={LOG_RING_CAPACITY}
        onClear={handleClear}
        onCopy={handleCopyAll}
        canCopy={visibleEntries.length > 0}
        scopes={availableScopes}
        sessionIds={availableSessionIds}
      />
      <EntryList
        listRef={listRef}
        onScroll={onListScroll}
        entries={visibleEntries}
        emptyMessage={t("No log entries match the current filters.")}
      />
    </div>
  );
}

// ── Toolbar ────────────────────────────────────────────────────────────────

interface ToolbarProps {
  paused: boolean;
  onTogglePause: () => void;
  droppedWhilePaused: number;
  connected: boolean;
  showing: number;
  capacity: number;
  onClear: () => void;
  onCopy: () => void;
  canCopy: boolean;
  scopes: string[];
  sessionIds: string[];
}

function Toolbar(props: ToolbarProps) {
  const { t } = useI18n();
  const state = useLogsState();

  return (
    <div style={{ display: "flex", flexDirection: "column", flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
      {/* Row 1: level chips + search + pause + clear + status */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", flexWrap: "wrap" }}>
        <ConnectionDot connected={props.connected} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginRight: 4 }}>{t("Logs")}</span>
        {ALL_LEVELS.map((lvl) => {
          const active = state.filters.levels.has(lvl);
          return (
            <button
              key={lvl}
              onClick={() => toggleLevel(lvl)}
              aria-pressed={active}
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 4,
                border: `1px solid ${active ? LEVEL_COLOR[lvl] : "var(--border)"}`,
                background: active ? LEVEL_BG[lvl] : "transparent",
                color: active ? LEVEL_COLOR[lvl] : "var(--text-dim)",
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                fontFamily: "var(--font-mono)",
                transition: "all 0.1s",
              }}
            >
              {lvl}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <input
          type="text"
          value={state.filters.query}
          onChange={(e) => setLogsQuery(e.target.value)}
          placeholder={t("Search messages, scopes, fields...")}
          spellCheck={false}
          style={{
            width: 200,
            height: 24,
            padding: "0 8px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            outline: "none",
          }}
        />
        <Tooltip content={props.paused ? t("Resume") : t("Pause incoming entries")}>
          <button
            onClick={props.onTogglePause}
            aria-pressed={props.paused}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              padding: 0,
              background: props.paused ? "var(--bg-selected)" : "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: props.paused ? "var(--accent)" : "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            {props.paused ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            )}
          </button>
        </Tooltip>
        <Tooltip content={t("Copy filtered entries to clipboard")}>
          <button
            onClick={props.onCopy}
            disabled={!props.canCopy}
            aria-label={t("Copy")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              padding: 0,
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: props.canCopy ? "var(--text-muted)" : "var(--text-dim)",
              cursor: props.canCopy ? "pointer" : "default",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip content={t("Clear logs (server buffer is preserved)")}>
          <button
            onClick={props.onClear}
            disabled={state.entries.length === 0}
            aria-label={t("Clear")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              padding: 0,
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: state.entries.length === 0 ? "var(--text-dim)" : "var(--text-muted)",
              cursor: state.entries.length === 0 ? "default" : "pointer",
            }}
            onMouseEnter={(e) => {
              if (state.entries.length > 0) e.currentTarget.style.color = "#ef4444";
            }}
            onMouseLeave={(e) => {
              if (state.entries.length > 0) e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </Tooltip>
      </div>
      {/* Row 2: scope + sessionId dropdowns + counters + paused banner */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px 6px", flexWrap: "wrap" }}>
        <FilterDropdown
          label={t("Scope")}
          emptyLabel={t("All scopes")}
          options={props.scopes}
          selected={state.filters.scopes}
          onChange={setLogsScopes}
        />
        <FilterDropdown
          label={t("Session")}
          emptyLabel={t("All sessions")}
          options={props.sessionIds}
          selected={state.filters.sessionId ? [state.filters.sessionId] : []}
          single
          onChange={(vals) => setLogsSessionId(vals[0] ?? null)}
        />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>
          {t("Showing {n} / {cap}").replace("{n}", String(props.showing)).replace("{cap}", String(props.capacity))}
        </span>
      </div>
      {props.paused && (
        <div style={{ padding: "4px 10px", background: "rgba(245, 158, 11, 0.12)", borderTop: "1px solid rgba(245, 158, 11, 0.25)", fontSize: 11, color: "#f59e0b", fontFamily: "var(--font-mono)" }}>
          {t("Paused — {n} entries dropped since you paused").replace("{n}", String(props.droppedWhilePaused))}
        </div>
      )}
    </div>
  );
}

function ConnectionDot({ connected }: { connected: boolean }) {
  const { t } = useI18n();
  const color = connected ? "#22c55e" : "#ef4444";
  return (
    <Tooltip content={connected ? t("Connected") : t("Disconnected")}>
      <span style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }} />
    </Tooltip>
  );
}

// ── Dropdown (single- or multi-select) ─────────────────────────────────────

interface FilterDropdownProps {
  label: string;
  emptyLabel: string;
  options: string[];
  selected: string[];
  onChange: (vals: string[]) => void;
  single?: boolean;
}

function FilterDropdown({ label, emptyLabel, options, selected, onChange, single }: FilterDropdownProps) {
  const { t } = useI18n();
  const openRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (openRef.current && !openRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const summary = selected.length === 0
    ? emptyLabel
    : selected.length === 1
      ? selected[0]
      : `${selected.length} selected`;

  return (
    <div ref={openRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          height: 22,
          background: selected.length > 0 ? "var(--bg-selected)" : "transparent",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: selected.length > 0 ? "var(--text)" : "var(--text-muted)",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          cursor: "pointer",
          maxWidth: 200,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: "var(--text-dim)" }}>{label}:</span>
        <span>{summary}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 100,
            minWidth: 200,
            maxHeight: 280,
            overflowY: "auto",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
            padding: 4,
          }}
        >
          {options.length === 0 ? (
            <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>
              {t("No options yet — wait for entries to arrive.")}
            </div>
          ) : (
            <>
              {!single && (
                <button
                  onClick={() => onChange([])}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "4px 8px",
                    fontSize: 11,
                    background: selected.length === 0 ? "var(--bg-selected)" : "transparent",
                    border: "none",
                    borderRadius: 3,
                    color: selected.length === 0 ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {emptyLabel}
                </button>
              )}
              {options.map((opt) => {
                const isSelected = selected.includes(opt);
                return (
                  <button
                    key={opt}
                    onClick={() => {
                      if (single) {
                        onChange(isSelected ? [] : [opt]);
                        setOpen(false);
                      } else {
                        onChange(isSelected ? selected.filter((v) => v !== opt) : [...selected, opt]);
                      }
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "4px 8px",
                      fontSize: 11,
                      background: isSelected ? "var(--bg-selected)" : "transparent",
                      border: "none",
                      borderRadius: 3,
                      color: isSelected ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {isSelected ? "✓ " : "  "}{opt}
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Entry list ─────────────────────────────────────────────────────────────

interface EntryListProps {
  listRef: React.MutableRefObject<HTMLDivElement | null>;
  onScroll: () => void;
  entries: LogEntry[];
  emptyMessage: string;
}

function EntryList({ listRef, onScroll, entries, emptyMessage }: EntryListProps) {
  if (entries.length === 0) {
    return (
      <div
        ref={listRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "20px 16px",
          color: "var(--text-dim)",
          fontSize: 12,
          fontStyle: "italic",
          textAlign: "center",
        }}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      onScroll={onScroll}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        background: "var(--bg)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      {entries.map((entry) => (
        <EntryRow key={entry.seq} entry={entry} />
      ))}
    </div>
  );
}

function EntryRow({ entry }: { entry: LogEntry }) {
  const color = LEVEL_COLOR[entry.level];
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "3px 12px",
        borderBottom: "1px solid var(--border)",
        background: LEVEL_BG[entry.level],
        alignItems: "flex-start",
      }}
    >
      <span style={{ color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{formatTime(entry.ts)}</span>
      <span style={{ color, flexShrink: 0, fontWeight: 600, width: 44, textTransform: "uppercase", fontSize: 10, letterSpacing: 0.5 }}>{entry.level}</span>
      <span style={{ color: "var(--text-muted)", flexShrink: 0, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={entry.scope}>{entry.scope}</span>
      <span style={{ color: "var(--text)", flex: 1, minWidth: 0, wordBreak: "break-word" }}>
        {entry.message}
        {entry.fieldsJson && <span style={{ color: "var(--text-dim)" }}> {entry.fieldsJson}</span>}
      </span>
    </div>
  );
}