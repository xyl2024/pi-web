"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { SessionTreeNode, AgentsFile } from "@/lib/types";

/**
 * Session-level UI state that is owned by useAgentSession (in ChatWindow) but
 * rendered by AppShell (in the top bar / branch navigator / context panel).
 *
 * The previous design used 5 separate `onXxxChange` callback props plus a
 * matching `useState` in AppShell for each field, with manual `useRef` +
 * `useEffect` sync machinery in ChatWindow to avoid identity-based re-render
 * loops. That pattern was repeated 5 times (~150 lines) and broke whenever
 * ChatWindow remounted (the cleanup-on-unmount effects wiped the top bar).
 *
 * The store is module-scoped: useAgentSession writes; AppShell reads via
 * `useSessionUiState()`. State survives ChatWindow remounts, eliminating the
 * top-bar flash on session switches. There is exactly one source of truth.
 *
 * Functions don't live in the snapshot (they would force infinite re-renders).
 * The branch-leaf-change handler is held in a ref instead, exposed via
 * `useSessionLeafChange()` which returns a stable wrapper.
 */

export type SessionStats = {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost?: number;
} | null;

export type ContextUsage = {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
} | null;

export interface SessionUiState {
  branchTree: SessionTreeNode[];
  branchActiveLeafId: string | null;
  systemPrompt: string | null;
  agentsFiles: AgentsFile[];
  sessionStats: SessionStats;
  contextUsage: ContextUsage;
}

const INITIAL: SessionUiState = {
  branchTree: [],
  branchActiveLeafId: null,
  systemPrompt: null,
  agentsFiles: [],
  sessionStats: null,
  contextUsage: null,
};

let state: SessionUiState = INITIAL;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/**
 * Shallow-merge a patch into the store. If no field actually changed, the
 * listeners are NOT notified.
 *
 * For object/array fields, reference equality is too strict — values
 * computed inline (e.g. `sessionStats` is an IIFE inside useAgentSession)
 * are a fresh object on every render even when their contents are identical,
 * which would cause the store to re-publish on every render and AppShell
 * to re-render its 522-session tree dozens of times per second. So we
 * compare object/array values by content instead of by reference.
 */
function isContentEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isContentEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!isContentEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

export function setSessionUiState(patch: Partial<SessionUiState>) {
  let changed = false;
  for (const k in patch) {
    const next = patch[k as keyof SessionUiState];
    const cur = state[k as keyof SessionUiState];
    if (!isContentEqual(next, cur)) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  emit();
}

function subscribeSessionUi(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSessionUiSnapshot(): SessionUiState {
  return state;
}

function getSessionUiServerSnapshot(): SessionUiState {
  return INITIAL;
}

export function useSessionUiState(): SessionUiState {
  return useSyncExternalStore(subscribeSessionUi, getSessionUiSnapshot, getSessionUiServerSnapshot);
}

/** Reset all session UI state. Call on session / cwd / new-session transitions. */
export function resetSessionUi() {
  state = INITIAL;
  emit();
}

// ── Branch leaf change handler ────────────────────────────────────────────
// The handler is a useCallback inside useAgentSession, regenerated on each
// render. We can't put it in the snapshot (would cause infinite loops) and
// we can't subscribe to "callback identity" usefully. Stash the latest one
// in a module ref; AppShell's BranchNavigator calls a stable wrapper that
// delegates to the ref.

let leafChangeHandlerRef: ((leafId: string | null) => void) | null = null;

export function setLeafChangeHandler(fn: ((leafId: string | null) => void) | null) {
  leafChangeHandlerRef = fn;
}

export function useSessionLeafChange(): (leafId: string | null) => void {
  return useCallback((leafId: string | null) => {
    leafChangeHandlerRef?.(leafId);
  }, []);
}
