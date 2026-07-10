"use client";

/**
 * Module store for the RSS panel's view + scroll-position state.
 *
 * Mirrors the sessionUiStore / toolCallStatsStore / httpStore pattern: a single
 * typed state object, useSyncExternalStore-based subscription, content-equality
 * guarded patcher. Owned by the RSS panel so its current view (feeds / articles
 * / reader), selected feed, open article, and per-view scroll position survive:
 *
 *   - tab switches inside the right panel (memory)
 *   - full page refresh / browser close (localStorage)
 *
 * localStorage write-back is throttled via requestAnimationFrame for the
 * scroll channel so a fast-firing scroll event results in at most one
 * localStorage write per frame; the view channel writes synchronously so a
 * navigation never loses its destination.
 */

import { useEffect, useSyncExternalStore } from "react";
import { isContentEqual } from "@/lib/shallowEqual";

// Keep the view shape in sync with `hooks/useRss.ts`. Duplicated here to avoid
// a circular import (useRss imports from rssStore, not the other way around).
export type RssViewKey =
  | { kind: "feeds" }
  | { kind: "articles"; feedId: string }
  | { kind: "reader"; feedId: string; articleId: string };

export interface RssPersistedState {
  view: RssViewKey;
  feedsScrollTop: number;
  articlesScrollTop: Record<string, number>;
  readerScrollTop: Record<string, Record<string, number>>;
  schemaVersion: 1;
}

const STORAGE_KEY = "pi-rss-view-state";
const SCHEMA_VERSION = 1 as const;

const INITIAL: RssPersistedState = {
  view: { kind: "feeds" },
  feedsScrollTop: 0,
  articlesScrollTop: {},
  readerScrollTop: {},
  schemaVersion: SCHEMA_VERSION,
};

let state: RssPersistedState = INITIAL;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / privacy mode — best effort */
  }
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<RssPersistedState> | null;
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return;
    state = {
      ...INITIAL,
      ...parsed,
      view: parsed.view ?? INITIAL.view,
      articlesScrollTop: parsed.articlesScrollTop ?? {},
      readerScrollTop: parsed.readerScrollTop ?? {},
    };
  } catch {
    /* corrupt JSON — leave INITIAL in place */
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): RssPersistedState {
  return state;
}

function getServerSnapshot(): RssPersistedState {
  return INITIAL;
}

export function useRssViewState(): RssPersistedState {
  // Hydrate on first client read. Runs after the first render so the SSR
  // markup stays in sync with the client first paint (both show INITIAL);
  // hydrate() then mutates state + emits, and the panel re-renders with the
  // saved view. This is the same trade-off JsonPanel / DiffPanel accept.
  useEffect(() => {
    hydrate();
    if (!hydrated) return;
    // After hydration, state may have changed without any subscribe-time emit
    // (the very first listener was registered against INITIAL). Force a
    // notification so the freshly-mounted consumer re-reads.
    emit();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function getRssViewState(): RssPersistedState {
  return state;
}

function patch(next: RssPersistedState) {
  if (isContentEqual(state, next)) return;
  state = next;
  emit();
  persist();
}

// ── Action helpers ───────────────────────────────────────────────────────

export function setRssView(view: RssViewKey) {
  // Flush any pending scroll write for the OLD view first, so a fast scroll
  // + immediate navigation never loses the previous view's position.
  flushRssScroll();
  patch({ ...state, view });
}

// Throttled scroll write — coalesces a burst of scroll events into at most
// one localStorage write per animation frame.
let pendingRaf = 0;
let pendingView: RssViewKey | null = null;
let pendingScrollTop = 0;

export function setRssScroll(view: RssViewKey, scrollTop: number) {
  if (typeof window === "undefined") return;
  pendingView = view;
  pendingScrollTop = scrollTop;
  if (pendingRaf) return;
  pendingRaf = window.requestAnimationFrame(() => {
    pendingRaf = 0;
    const v = pendingView;
    const t = pendingScrollTop;
    pendingView = null;
    if (v) flushRssScrollNow(v, t);
  });
}

function flushRssScrollNow(view: RssViewKey, scrollTop: number) {
  let next: RssPersistedState;
  if (view.kind === "feeds") {
    if (state.feedsScrollTop === scrollTop) return;
    next = { ...state, feedsScrollTop: scrollTop };
  } else if (view.kind === "articles") {
    if (state.articlesScrollTop[view.feedId] === scrollTop) return;
    next = {
      ...state,
      articlesScrollTop: { ...state.articlesScrollTop, [view.feedId]: scrollTop },
    };
  } else {
    const existingFeed = state.readerScrollTop[view.feedId] ?? {};
    if (existingFeed[view.articleId] === scrollTop) return;
    next = {
      ...state,
      readerScrollTop: {
        ...state.readerScrollTop,
        [view.feedId]: { ...existingFeed, [view.articleId]: scrollTop },
      },
    };
  }
  patch(next);
}

/**
 * Flush any pending throttled scroll write immediately. Call from
 * `pagehide` / `visibilitychange:hidden` so the last scroll position makes
 * it to disk before the page unloads.
 */
export function flushRssScroll() {
  if (!pendingRaf) return;
  if (typeof window !== "undefined") window.cancelAnimationFrame(pendingRaf);
  pendingRaf = 0;
  const v = pendingView;
  const t = pendingScrollTop;
  pendingView = null;
  if (v) flushRssScrollNow(v, t);
}

/**
 * Remove orphaned scroll keys after a feed (or its articles) was deleted.
 * Used by the panel's stale-data fallback path.
 */
export function clearRssScrollForFeed(feedId: string) {
  if (!(feedId in state.articlesScrollTop) && !(feedId in state.readerScrollTop)) {
    return;
  }
  const articlesTop = { ...state.articlesScrollTop };
  delete articlesTop[feedId];
  const readerTop = { ...state.readerScrollTop };
  delete readerTop[feedId];
  patch({
    ...state,
    articlesScrollTop: articlesTop,
    readerScrollTop: readerTop,
  });
}

/** Look up the saved scroll position for a given view. */
export function scrollTopForView(view: RssViewKey): number | undefined {
  if (view.kind === "feeds") return state.feedsScrollTop;
  if (view.kind === "articles") return state.articlesScrollTop[view.feedId];
  return state.readerScrollTop[view.feedId]?.[view.articleId];
}