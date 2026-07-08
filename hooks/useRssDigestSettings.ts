"use client";

/**
 * Client-side hook for the RSS daily digest settings.
 *
 * Mirrors `hooks/useRss.ts`:
 *   - Single full-snapshot GET on mount + window focus.
 *   - No polling — digest settings change infrequently, the form's local
 *     state is the source of truth between fetches.
 *   - Errors surface via the returned `error` field; the caller decides
 *     whether to toast or render inline.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RssDigestSettings, RssDigestSettingsPatch } from "@/lib/rss-digest-schema";

export interface UseRssDigestSettingsState {
  settings: RssDigestSettings | null;
  isLoading: boolean;
  error: Error | null;
  update: (patch: RssDigestSettingsPatch) => Promise<RssDigestSettings>;
}

async function parseError(res: Response, fallback: string): Promise<Error> {
  let body: { error?: string; field?: string } = {};
  try {
    body = (await res.json()) as { error?: string; field?: string };
  } catch {
    /* body wasn't JSON */
  }
  const fieldSuffix = body.field ? ` (${body.field})` : "";
  return new Error(`${body.error ?? fallback}${fieldSuffix}`);
}

export function useRssDigestSettings(): UseRssDigestSettingsState {
  const [settings, setSettings] = useState<RssDigestSettings | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current;
    const p = (async () => {
      setIsLoading(true);
      try {
        const res = await fetch("/api/rss/digest-settings", { cache: "no-store" });
        if (!res.ok) {
          throw await parseError(res, `Failed to load digest settings (${res.status})`);
        }
        const data = (await res.json()) as { settings: RssDigestSettings };
        setSettings(data.settings);
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

  const update = useCallback(
    async (patch: RssDigestSettingsPatch): Promise<RssDigestSettings> => {
      const res = await fetch("/api/rss/digest-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw await parseError(res, "Failed to save digest settings");
      const data = (await res.json()) as { settings: RssDigestSettings };
      setSettings(data.settings);
      setError(null);
      return data.settings;
    },
    [],
  );

  return { settings, isLoading, error, update };
}