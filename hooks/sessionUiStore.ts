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
 * listeners are NOT notified — this is what replaces the old "scalar key"
 * workaround in ChatWindow.
 */
export function setSessionUiState(patch: Partial<SessionUiState>) {
  let changed = false;
  for (const k in patch) {
    if (patch[k as keyof SessionUiState] !== state[k as keyof SessionUiState]) {
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
