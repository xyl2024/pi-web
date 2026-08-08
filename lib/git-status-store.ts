"use client";

/**
 * Module-scoped git status store + folder aggregation helper.
 *
 * Mirrors the pattern in `sessionUiStore` and `toolCallStatsStore`:
 * one source of truth, useSyncExternalStore-backed subscription, content-
 * equality guarded patches so re-renders only fire when the visible
 * status actually changes.
 *
 * Polling lifecycle is owned by the store: callers call `startTracking(cwd)`
 * when they want live updates (FileExplorer on mount / cwd change) and
 * `stopTracking()` when the consumer is no longer visible (explorer
 * collapsed). `notifyMutated(cwd)` is called from anywhere that knows
 * the worktree may have just changed (FileExplorer after a write/delete
 * via the existing `onFileMutated` hook); it triggers an immediate
 * refetch and reschedules the next tick.
 *
 * The store deliberately keeps status entries across session switches:
 * switching from cwd A to cwd B and back leaves A's badges cached, so
 * FileExplorer paints them instantly rather than waiting up to 3s.
 */

import { useSyncExternalStore } from "react";
import { isContentEqual } from "@/lib/shallowEqual";
import type { GitDiffFile, GitFileStatus, GitStatusResponse } from "@/lib/git-diff-types";

export type GitRepoStatusEntry = GitStatusResponse;

export interface GitStatusStoreState {
  /** Per-cwd cached status. Persists across session switches. */
  entriesByCwd: Map<string, GitRepoStatusEntry>;
  /** True for cwds known to be inside a git repo (last fetch returned a
   *  non-null repoRoot). Lets the FileExplorer skip the badge rendering
   *  branch and skip polling without re-asking git on every cycle. */
  isRepoByCwd: Map<string, boolean>;
  /** The cwd currently being polled. Null = polling paused. Only one
   *  cwd is active at a time (the FileExplorer shows one cwd). */
  currentCwd: string | null;
}

const EMPTY: GitStatusStoreState = {
  entriesByCwd: new Map(),
  isRepoByCwd: new Map(),
  currentCwd: null,
};

let state: GitStatusStoreState = EMPTY;
const listeners = new Set<() => void>();

/** 3s matches the cadence we agreed on in the design grill. */
const POLL_INTERVAL_MS = 3_000;
/** Hard cap on a single /api/git round-trip. The server-side cache is
 *  2s, so a stale request usually resolves within a second; this cap
 *  exists to prevent a wedged server from holding the poll loop forever. */
const FETCH_TIMEOUT_MS = 10_000;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let fetchAbort: AbortController | null = null;

function emit() {
  for (const l of listeners) l();
}

function patch(p: Partial<GitStatusStoreState>) {
  let changed = false;
  for (const k in p) {
    if (!isContentEqual(p[k as keyof GitStatusStoreState], state[k as keyof GitStatusStoreState])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...p };
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): GitStatusStoreState {
  return state;
}

function getServerSnapshot(): GitStatusStoreState {
  return EMPTY;
}

export function useGitStatusStore(): GitStatusStoreState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ── Polling lifecycle ─────────────────────────────────────────────────────

/** Begin polling `cwd`. Idempotent if cwd is already the current one. */
export function startTracking(cwd: string): void {
  if (state.currentCwd === cwd) return;

  // Switching cwds — abort any in-flight fetch for the previous cwd so
  // its response can't overwrite the new cwd's entry.
  if (fetchAbort) {
    fetchAbort.abort();
    fetchAbort = null;
  }
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  patch({ currentCwd: cwd });

  // Always fetch — even when there's a cached entry — so a long pause
  // between sessions doesn't leave the user looking at stale badges.
  void fetchAndStore(cwd);
  scheduleNextTick(cwd);
}

/** Pause polling. Cached entries are retained for instant resume. */
export function stopTracking(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (fetchAbort) {
    fetchAbort.abort();
    fetchAbort = null;
  }
  patch({ currentCwd: null });
}

/** Tell the store the worktree may have just changed for `cwd`. Triggers
 *  an immediate refetch and reschedules the next tick to be 3s from now.
 *  No-op for non-active cwds (their consumers aren't rendering anyway). */
export function notifyMutated(cwd: string): void {
  if (state.currentCwd !== cwd) return;
  void fetchAndStore(cwd);
  scheduleNextTick(cwd);
}

function scheduleNextTick(cwd: string) {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  pollTimer = setTimeout(() => {
    if (state.currentCwd !== cwd) return; // cwd changed mid-flight
    void fetchAndStore(cwd);
    scheduleNextTick(cwd);
  }, POLL_INTERVAL_MS);
}

async function fetchAndStore(cwd: string): Promise<void> {
  // Cancel any in-flight fetch — only one request per cwd at a time.
  // When notifyMutated fires within ms of a scheduled tick, this dedupes
  // them so we never run git status back-to-back.
  if (fetchAbort) {
    fetchAbort.abort();
  }
  fetchAbort = new AbortController();
  const signal = fetchAbort.signal;
  // Auto-abort after the hard timeout so a hung server can't pin the
  // loop forever.
  const timeoutId = setTimeout(() => fetchAbort?.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`/api/git?cwd=${encodeURIComponent(cwd)}`, { signal });
    if (!res.ok) return;
    const data = (await res.json()) as GitStatusResponse;

    // Bail if cwd changed while we were fetching.
    if (state.currentCwd !== cwd) return;

    const nextEntries = new Map(state.entriesByCwd);
    nextEntries.set(cwd, data);

    const nextIsRepo = new Map(state.isRepoByCwd);
    nextIsRepo.set(cwd, data.repoRoot !== null);

    patch({ entriesByCwd: nextEntries, isRepoByCwd: nextIsRepo });
  } catch (e) {
    // AbortError is expected on cwd-switch and timeout; silent.
    if ((e as Error).name === "AbortError") return;
    // Anything else: leave the previous entry in place. The next tick
    // will retry; surfacing transient network failures to the user via
    // a toast on every 3s tick would be far worse than the bug.
  } finally {
    clearTimeout(timeoutId);
    if (fetchAbort?.signal === signal) fetchAbort = null;
  }
}

// ── Folder aggregation ───────────────────────────────────────────────────────

/** Priority order for "worst" status of a folder: conflict > modified >
 *  deleted > added > renamed/copied/typechange > untracked. Matches the
 *  ordering we agreed on in the design grill. Lower number = higher
 *  priority; the first non-undefined wins. */
const PRIORITY: Record<GitFileStatus, number> = {
  U: 0, // conflict (unmerged) — most urgent
  M: 1,
  D: 2,
  A: 3,
  R: 4,
  C: 4,
  T: 4,
  "??": 5,
};

function worstStatus(a: GitFileStatus | undefined, b: GitFileStatus): GitFileStatus {
  if (a === undefined) return b;
  return PRIORITY[a] <= PRIORITY[b] ? a : b;
}

/**
 * Walk a flat list of `files` (paths relative to cwd) and produce a map
 * from directory path (also relative to cwd) → worst status of any file
 * in that directory or any subdirectory beneath it.
 *
 * Empty path key `""` corresponds to cwd itself, so callers can render
 * a top-level badge without special-casing.
 *
 * Folder aggregation is recursive by design — a folder reflects any
 * change in its subtree, matching VSCode. The walk is O(N * depth); for
 * typical repos (N < 1000, depth < 10) this is negligible. For very
 * deep paths it would be O(N * log N) in practice because most files
 * share long prefixes.
 */
export function aggregateFolderStatuses(files: GitDiffFile[]): Map<string, GitFileStatus> {
  const map = new Map<string, GitFileStatus>();
  for (const f of files) {
    let dir = dirnamePosix(f.path);
    while (true) {
      const cur = map.get(dir);
      const next = worstStatus(cur, f.status);
      if (cur === next) {
        // No change at this level — but we still have to keep walking
        // because a deeper file might still be earlier than the existing
        // entry. We only short-circuit the *write*, not the *traversal*.
      }
      map.set(dir, next);
      if (dir === "") break;
      dir = parentDirPosix(dir);
    }
  }
  return map;
}

/** `path.posix.dirname` reimplemented inline so we don't drag Node's
 *  `path` into a client bundle. Treats the input as POSIX (git paths
 *  use forward slashes regardless of host OS). */
function dirnamePosix(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function parentDirPosix(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
}