"use client";

import { useEffect, useRef, useState } from "react";

export interface InboxMessage {
  id: string;
  ts: number;
  source: string;
  level: "info" | "warn" | "error";
  title: string;
  payload?: Record<string, unknown>;
}

const POLL_INTERVAL_MS = 5_000;
const DEFAULT_LIMIT = 200;

/**
 * Polls the full message list while the Inbox modal is open. Stops polling
 * immediately on unmount so no background traffic is generated when the
 * modal is closed.
 *
 * Caller bumps `refreshKey` after mutating actions (delete / clear) to
 * force an immediate refetch instead of waiting for the next interval.
 */
export function useInbox(open: boolean, refreshKey: number = 0) {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    cancelledRef.current = false;

    const fetchOnce = async (showLoading: boolean) => {
      if (showLoading) setLoading(true);
      try {
        const res = await fetch(
          `/api/inbox/messages?limit=${DEFAULT_LIMIT}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { messages: InboxMessage[] };
        if (!cancelledRef.current) {
          setMessages(data.messages);
          setError(null);
        }
      } catch (e) {
        if (!cancelledRef.current) {
          setError(e instanceof Error ? e.message : "Network error");
        }
      } finally {
        if (!cancelledRef.current && showLoading) setLoading(false);
      }
    };

    void fetchOnce(true);
    const id = setInterval(() => void fetchOnce(false), POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [open, refreshKey]);

  return { messages, loading, error };
}