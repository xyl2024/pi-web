"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { ToolCallStatsSnapshot } from "./useToolCallStats";

/**
 * Module store mirroring `sessionUiStore`: ChatWindow owns the underlying
 * reducer state (because it has the `messages` array), and writes the latest
 * view into this store. AppShell reads from it to render the vertical button
 * + the right-panel tab body without prop-drilling messages upward.
 *
 * Functions don't live in the snapshot (would cause infinite re-renders); the
 * scroll-to-tool-call callback is held in a ref and exposed via a stable
 * wrapper hook, the same pattern used for the branch leaf-change handler.
 */

export interface ToolCallStatsView {
  snapshot: ToolCallStatsSnapshot;
  runningSummary: string | undefined;
}

const EMPTY_SNAPSHOT: ToolCallStatsSnapshot = {
  toolStats: new Map(),
  waterfall: [],
  totalCount: 0,
  runningCount: 0,
};

const INITIAL: ToolCallStatsView = {
  snapshot: EMPTY_SNAPSHOT,
  runningSummary: undefined,
};

let state: ToolCallStatsView = INITIAL;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/**
 * Compare Maps + Arrays + plain objects by content. Used so a new `useReducer`
 * dispatch (which rebuilds Maps every time) only fires listeners when the
 * visible stats actually changed.
 */
function isContentEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  const aIsMap = a instanceof Map;
  const bIsMap = b instanceof Map;
  if (aIsMap !== bIsMap) return false;
  if (aIsMap && bIsMap) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      const bv = b.get(k);
      if (!isContentEqual(v, bv)) return false;
    }
    return true;
  }

  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return false;
  if (aIsArr && bIsArr) {
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

export function setToolCallStatsState(patch: Partial<ToolCallStatsView>) {
  let changed = false;
  for (const k in patch) {
    const next = patch[k as keyof ToolCallStatsView];
    const cur = state[k as keyof ToolCallStatsView];
    if (!isContentEqual(next, cur)) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  emit();
}

export function resetToolCallStatsView() {
  state = INITIAL;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ToolCallStatsView {
  return state;
}

function getServerSnapshot(): ToolCallStatsView {
  return INITIAL;
}

export function useToolCallStatsView(): ToolCallStatsView {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ── Scroll callback registry ──────────────────────────────────────────────
// ChatWindow's `handleScrollToToolCall` depends on `toolCallToVisibleIdx` which
// is rebuilt every time `messages` changes, so its identity is unstable. We
// stash the latest callback in a module ref and expose a stable wrapper.

let scrollCallbackRef: ((toolCallId: string) => void) | null = null;

export function setToolCallStatsScrollCallback(fn: ((toolCallId: string) => void) | null) {
  scrollCallbackRef = fn;
}

export function useToolCallStatsScroll(): (toolCallId: string) => void {
  return useCallback((toolCallId: string) => {
    scrollCallbackRef?.(toolCallId);
  }, []);
}