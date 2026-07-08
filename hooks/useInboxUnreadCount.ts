"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface MessageListResponse {
  messages: Array<{
    id: string;
    ts: number;
    source: string;
    level: string;
    title: string;
    payload?: Record<string, unknown>;
  }>;
}

const STORAGE_KEY = "inbox.lastSeenTs";
const POLL_INTERVAL_MS = 30_000;

function readLastSeenTs(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeLastSeenTs(ts: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(ts));
  } catch {
    // ignore — private mode etc.
  }
}

/**
 * Global hook for the Inbox bell badge. Mount once at the AppShell level.
 *
 * - Polls `/api/inbox/messages?since=<lastSeenTs>` every 30s to compute the
 *   unread count. The polling interval is intentionally long because the bell
 *   only needs to know "how many" — the modal does its own 5s polling while
 *   open for the full list.
 * - Persists `lastSeenTs` in localStorage so the badge survives reloads.
 * - `markAllSeen()` is called by the modal on close and bumps the timestamp,
 *   collapsing the badge to zero.
 */
export function useInboxUnreadCount() {
  const [unread, setUnread] = useState(0);
  const lastSeenTsRef = useRef(0);

  useEffect(() => {
    lastSeenTsRef.current = readLastSeenTs();
  }, []);

  const fetchUnread = useCallback(async () => {
    try {
      const since = lastSeenTsRef.current;
      const url = `/api/inbox/messages?since=${since}&limit=500`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as MessageListResponse;
      setUnread(data.messages.length);
    } catch {
      // ignore — next tick will retry
    }
  }, []);

  useEffect(() => {
    void fetchUnread();
    const id = setInterval(fetchUnread, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchUnread]);

  const markAllSeen = useCallback(() => {
    const now = Date.now();
    lastSeenTsRef.current = now;
    writeLastSeenTs(now);
    setUnread(0);
  }, []);

  const refresh = useCallback(() => {
    void fetchUnread();
  }, [fetchUnread]);

  return { unread, markAllSeen, refresh };
}