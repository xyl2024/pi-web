"use client";

/**
 * Client-side hook for the RSS panel.
 *
 * Mirrors `hooks/useHttpCollections.ts`:
 *   - Single full-snapshot GET on mount + window focus.
 *   - `inFlightRef` guards against overlapping refetches.
 *   - Errors are surfaced as toasts by the call sites (the hook itself just
 *     stores the latest `Error` and lets the caller decide what to do).
 *   - A transient fetch failure does NOT clear the in-memory data — the
 *     panel keeps showing the last good snapshot.
 *
 * Articles are loaded lazily per-feed (only when the user navigates into
 * the articles view) and cached in `articlesByFeed` for instant back/forward
 * navigation within a single feed.
 *
 * View state (feeds / articles / reader + selection) is sourced from
 * `hooks/rssStore.ts` so it survives both tab switches inside the right panel
 * and full page refreshes; data (feeds list + articles cache) stays local to
 * this hook because it is server-driven and re-fetched lazily.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FetchResult,
  RssArticle,
  RssFeed,
} from "@/lib/rss-schema";
import { setRssView, useRssViewState, type RssViewKey } from "@/hooks/rssStore";

export type RssView = RssViewKey;

export interface UseRssState {
  feeds: RssFeed[];
  articlesByFeed: Record<string, RssArticle[]>;
  isLoading: boolean;
  error: Error | null;
  view: RssView;
  navigate: (next: RssView) => void;
  refresh: () => Promise<void>;
  addFeed: (input: { url: string; title?: string | null }) => Promise<RssFeed>;
  removeFeed: (id: string) => Promise<void>;
  renameFeed: (id: string, title: string | null) => Promise<RssFeed>;
  refreshFeed: (id: string) => Promise<FetchResult | null>;
  loadArticles: (feedId: string, opts?: { unreadOnly?: boolean }) => Promise<RssArticle[]>;
  markArticleRead: (articleId: string, read: boolean) => Promise<RssArticle>;
  markAllFeedRead: (feedId: string) => Promise<number>;
}

async function parseError(res: Response, fallback: string): Promise<Error> {
  let body: { error?: string; message?: string } = {};
  try {
    body = (await res.json()) as { error?: string; message?: string };
  } catch {
    /* body wasn't JSON */
  }
  return new Error(body.error || body.message || fallback);
}

export function useRss(): UseRssState {
  const [feeds, setFeeds] = useState<RssFeed[]>([]);
  const [articlesByFeed, setArticlesByFeed] = useState<Record<string, RssArticle[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const view = useRssViewState().view;

  // Guard against overlapping feed-list fetches (rapid focus events).
  const inFlightRef = useRef<Promise<void> | null>(null);
  // Track per-feed article loads so the "Loading…" state can be reflected if
  // needed later; the hook itself doesn't expose it yet.
  const articlesInFlightRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current;
    const p = (async () => {
      setIsLoading(true);
      try {
        const res = await fetch("/api/rss/feeds", { cache: "no-store" });
        if (!res.ok) {
          throw await parseError(res, `Failed to load feeds (${res.status})`);
        }
        const data = (await res.json()) as { feeds: RssFeed[] };
        setFeeds(data.feeds);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setIsLoading(false);
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = p;
    return p;
  }, []);

  // Initial fetch + window focus refetch (Y1 pattern from useHttpCollections).
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const navigate = useCallback((next: RssView) => {
    setRssView(next);
  }, []);

  const addFeed = useCallback(
    async (input: { url: string; title?: string | null }): Promise<RssFeed> => {
      const res = await fetch("/api/rss/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw await parseError(res, "Failed to add feed");
      const data = (await res.json()) as { feed: RssFeed };
      await refresh();
      return data.feed;
    },
    [refresh],
  );

  const removeFeed = useCallback(
    async (id: string): Promise<void> => {
      const res = await fetch(`/api/rss/feeds/${id}`, { method: "DELETE" });
      if (!res.ok) throw await parseError(res, "Failed to delete feed");
      await refresh();
      // Drop cached articles for this feed and reset the view if it pointed
      // at it.
      setArticlesByFeed((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (view.kind !== "feeds" && view.feedId === id) {
        setRssView({ kind: "feeds" });
      }
    },
    [refresh, view],
  );

  const renameFeed = useCallback(
    async (id: string, title: string | null): Promise<RssFeed> => {
      const res = await fetch(`/api/rss/feeds/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw await parseError(res, "Failed to rename feed");
      const data = (await res.json()) as { feed: RssFeed };
      await refresh();
      return data.feed;
    },
    [refresh],
  );

  const refreshFeed = useCallback(
    async (id: string): Promise<FetchResult | null> => {
      const res = await fetch(`/api/rss/feeds/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: true }),
      });
      if (!res.ok) throw await parseError(res, "Failed to refresh feed");
      const data = (await res.json()) as { feed: RssFeed; refreshResult: FetchResult | null };
      // Refresh the feed list so the updated unreadCount / lastError show up.
      await refresh();
      // If we have articles cached for this feed, refresh them too so the
      // user sees new entries without navigating away.
      if (articlesByFeed[id]) {
        const articlesRes = await fetch(
          `/api/rss/feeds/${id}/articles?limit=500`,
          { cache: "no-store" },
        );
        if (articlesRes.ok) {
          const articlesData = (await articlesRes.json()) as { articles: RssArticle[] };
          setArticlesByFeed((prev) => ({ ...prev, [id]: articlesData.articles }));
        }
      }
      return data.refreshResult;
    },
    [refresh, articlesByFeed],
  );

  const loadArticles = useCallback(
    async (feedId: string, opts: { unreadOnly?: boolean } = {}): Promise<RssArticle[]> => {
      articlesInFlightRef.current.add(feedId);
      try {
        const qs = opts.unreadOnly ? "?unreadOnly=true&limit=500" : "?limit=500";
        const res = await fetch(`/api/rss/feeds/${feedId}/articles${qs}`, {
          cache: "no-store",
        });
        if (!res.ok) throw await parseError(res, "Failed to load articles");
        const data = (await res.json()) as { articles: RssArticle[] };
        setArticlesByFeed((prev) => ({ ...prev, [feedId]: data.articles }));
        return data.articles;
      } finally {
        articlesInFlightRef.current.delete(feedId);
      }
    },
    [],
  );

  const markArticleRead = useCallback(
    async (articleId: string, read: boolean): Promise<RssArticle> => {
      const res = await fetch(`/api/rss/articles/${articleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read }),
      });
      if (!res.ok) throw await parseError(res, "Failed to mark article");
      const data = (await res.json()) as { article: RssArticle };
      // Update local cache in place + bump feed unread_count.
      setArticlesByFeed((prev) => {
        const arr = prev[data.article.feedId];
        if (!arr) return prev;
        return {
          ...prev,
          [data.article.feedId]: arr.map((a) => (a.id === articleId ? data.article : a)),
        };
      });
      setFeeds((prev) =>
        prev.map((f) => {
          if (f.id !== data.article.feedId) return f;
          const delta = read ? -1 : 1;
          return { ...f, unreadCount: Math.max(0, f.unreadCount + delta) };
        }),
      );
      return data.article;
    },
    [],
  );

  const markAllFeedRead = useCallback(
    async (feedId: string): Promise<number> => {
      const res = await fetch("/api/rss/articles/mark-all-read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedId }),
      });
      if (!res.ok) throw await parseError(res, "Failed to mark all as read");
      const data = (await res.json()) as { updated: number };
      // Local: mark cached articles read, zero out unread count.
      setArticlesByFeed((prev) => {
        const arr = prev[feedId];
        if (!arr) return prev;
        const now = Date.now();
        return {
          ...prev,
          [feedId]: arr.map((a) => (a.readAt === null ? { ...a, readAt: now } : a)),
        };
      });
      setFeeds((prev) =>
        prev.map((f) => (f.id === feedId ? { ...f, unreadCount: 0 } : f)),
      );
      return data.updated;
    },
    [],
  );

  return {
    feeds,
    articlesByFeed,
    isLoading,
    error,
    view,
    navigate,
    refresh,
    addFeed,
    removeFeed,
    renameFeed,
    refreshFeed,
    loadArticles,
    markArticleRead,
    markAllFeedRead,
  };
}