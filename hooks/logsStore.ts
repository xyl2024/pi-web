"use client";

import { useSyncExternalStore } from "react";
import type { LogEntry, LogLevel } from "@/lib/log-types";
import { LOG_RING_CAPACITY } from "@/lib/log-types";
import { isContentEqual } from "@/lib/shallowEqual";

/**
 * Module store for the LogsCenter right-panel tab.
 *
 * Mirrors the `httpStore` / `sessionUiStore` pattern: a single typed state
 * object, useSyncExternalStore subscription, content-equality guarded
 * patcher. The LogsPanel UI reads + dispatches everything through this store
 * so the in-flight filter state survives tab switches and panel closes.
 *
 * Pause semantics: incoming SSE `entry` events that arrive while `paused` is
 * true are dropped *before* they reach `entries`, and the
 * `droppedWhilePaused` counter is incremented so the UI can show the user
 * how much they missed. Resuming clears the counter.
 */

export type { LogEntry, LogLevel };

export const ALL_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export interface LogsFilters {
  /** Levels the user wants to see. Empty = show none. */
  levels: Set<LogLevel>;
  /** Scope allowlist. Empty array = all scopes. */
  scopes: string[];
  /** Session-ID allowlist (parsed from `fields.sessionId`). null = all. */
  sessionId: string | null;
  /** Free-text query: case-insensitive substring match against message,
   *  scope, and the JSON-stringified fields object. */
  query: string;
}

export interface LogsState {
  entries: LogEntry[];
  filters: LogsFilters;
  paused: boolean;
  /** Increments while paused; reset on resume. Surfaced in the UI banner. */
  droppedWhilePaused: number;
  /** Reflects the SSE connection state. */
  connected: boolean;
}

const INITIAL_FILTERS: LogsFilters = {
  // Default `debug` off — info/warn/error on. Keeps the panel readable on
  // first open in development where debug-level writes are abundant.
  levels: new Set<LogLevel>(["info", "warn", "error"]),
  scopes: [],
  sessionId: null,
  query: "",
};

const INITIAL: LogsState = {
  entries: [],
  filters: INITIAL_FILTERS,
  paused: false,
  droppedWhilePaused: 0,
  connected: false,
};

let state: LogsState = INITIAL;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setLogsState(patch: Partial<LogsState>) {
  let changed = false;
  for (const k in patch) {
    if (!isContentEqual(patch[k as keyof LogsState], state[k as keyof LogsState])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  emit();
}

// ── Entry ingestion (driven by SSE events) ─────────────────────────────────

/** Replace the entire entry list — used on initial `snapshot` event. */
export function setLogEntries(entries: LogEntry[]) {
  setLogsState({ entries });
}

/** Append one entry. Honors pause: dropped entries bump the counter. */
export function appendLogEntry(entry: LogEntry) {
  if (state.paused) {
    setLogsState({ droppedWhilePaused: state.droppedWhilePaused + 1 });
    return;
  }
  const next = state.entries.concat(entry);
  if (next.length > LOG_RING_CAPACITY) {
    next.splice(0, next.length - LOG_RING_CAPACITY);
  }
  setLogsState({ entries: next });
}

// ── UI actions ─────────────────────────────────────────────────────────────

export function clearLogs() {
  setLogsState({ entries: [], droppedWhilePaused: 0 });
}

export function setLogsPaused(paused: boolean) {
  setLogsState({ paused, droppedWhilePaused: 0 });
}

export function setLogsConnected(connected: boolean) {
  setLogsState({ connected });
}

export function toggleLevel(level: LogLevel) {
  const cur = state.filters.levels;
  const next = new Set(cur);
  if (next.has(level)) next.delete(level);
  else next.add(level);
  setLogsState({ filters: { ...state.filters, levels: next } });
}

export function setLogsQuery(query: string) {
  setLogsState({ filters: { ...state.filters, query } });
}

export function setLogsSessionId(sessionId: string | null) {
  setLogsState({ filters: { ...state.filters, sessionId } });
}

export function setLogsScopes(scopes: string[]) {
  setLogsState({ filters: { ...state.filters, scopes } });
}

// ── Filtering helpers (exported so the panel can compute derived lists) ───

/** Best-effort parse of `fields.sessionId` out of a log entry. */
export function getEntrySessionId(entry: LogEntry): string | null {
  if (!entry.fieldsJson) return null;
  try {
    const obj = JSON.parse(entry.fieldsJson) as Record<string, unknown>;
    const sid = obj.sessionId;
    return typeof sid === "string" ? sid : null;
  } catch {
    return null;
  }
}

export function entryMatchesFilters(entry: LogEntry, filters: LogsFilters): boolean {
  if (!filters.levels.has(entry.level)) return false;
  if (filters.scopes.length > 0 && !filters.scopes.includes(entry.scope)) return false;
  if (filters.sessionId) {
    const sid = getEntrySessionId(entry);
    if (sid !== filters.sessionId) return false;
  }
  const q = filters.query.trim().toLowerCase();
  if (q.length > 0) {
    if (
      !entry.message.toLowerCase().includes(q) &&
      !entry.scope.toLowerCase().includes(q) &&
      !(entry.fieldsJson?.toLowerCase().includes(q))
    ) {
      return false;
    }
  }
  return true;
}

// ── React glue ─────────────────────────────────────────────────────────────

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): LogsState {
  return state;
}

function getServerSnapshot(): LogsState {
  return INITIAL;
}

export function useLogsState(): LogsState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export { LOG_RING_CAPACITY };