"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { ToolCallStatsSnapshot } from "./useToolCallStats";
import { isContentEqual } from "@/lib/shallowEqual";

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