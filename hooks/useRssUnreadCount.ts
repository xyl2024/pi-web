"use client";

import { useCallback, useEffect, useState } from "react";

const POLL_INTERVAL_MS = 60_000;

/**
 * Global hook for the RSS right-bar button unread badge. Mount once at the
 * AppShell level.
 *
 * - Polls `/api/rss/feeds` every 60s and reports the sum of every feed's
 *   `unreadCount`. Mirrors `useInboxUnreadCount`'s structure: the badge
 *   reflects the DB truth, and reading articles in the RSS panel (which
 *   marks them read server-side) drops the badge on the next tick.
 * - The interval is deliberately longer than the inbox's 30s — the feeds
 *   list endpoint has no size concern, but a 60s cadence comfortably
 *   outpaces the 30-minute background fetch loop while staying cheap.
 */
export function useRssUnreadCount() {
  const [unread, setUnread] = useState(0);

  const fetchUnread = useCallback(async () => {
    try {
      const res = await fetch("/api/rss/feeds", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { feeds: Array<{ unreadCount?: number }> };
      const total = (data.feeds ?? []).reduce(
        (sum, f) => sum + (typeof f.unreadCount === "number" ? f.unreadCount : 0),
        0,
      );
      setUnread(total);
    } catch {
      // ignore — next tick will retry
    }
  }, []);

  useEffect(() => {
    void fetchUnread();
    const id = setInterval(fetchUnread, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchUnread]);

  const refresh = useCallback(() => {
    void fetchUnread();
  }, [fetchUnread]);

  return { unread, refresh };
}
