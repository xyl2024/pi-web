"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { PiWorkConfig } from "@/lib/config";
import { isContentEqual } from "@/lib/shallowEqual";

/**
 * Settings store — client-side mirror of ~/.pi-work/config.yaml.
 *
 * Pattern follows hooks/sessionUiStore.ts (module-scoped state +
 * useSyncExternalStore + isContentEqual guard) per the CLAUDE.md rule:
 * "When adding a new cross-cutting UI state, follow this pattern — it
 * survives ChatWindow remounts and eliminates prop-drilling."
 *
 * Two writers:
 *   - useEnsureSettings(): initial fetch on AppShell mount
 *   - SettingsModal handleSave / handleRightBarToggle: writes after a
 *     successful PUT so AppShell re-renders without a refetch round-trip
 *
 * Two readers:
 *   - AppShell (via useEnsureSettings): gates the right button bar
 *   - SettingsModal (via useSettings): reads current snapshot for the
 *     checkbox row initial state
 *
 * `state === null` means "not yet fetched (or fetch failed)". Callers
 * treat that as "fall back to defaults" — AppShell renders every button
 * as visible while the fetch is in flight or after a failure.
 */

let state: PiWorkConfig | null = null;
let initialFetchStarted = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setSettings(next: PiWorkConfig) {
  if (state && isContentEqual(state, next)) return;
  state = next;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): PiWorkConfig | null {
  return state;
}

function getServerSnapshot(): PiWorkConfig | null {
  return null;
}

export function useSettings(): PiWorkConfig | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Read the settings snapshot and trigger the one-time initial fetch.
 * Safe to call from AppShell — fires at most once across remounts
 * (initialFetchStarted is module-scoped) and across React strict-mode
 * double-invokes.
 */
export function useEnsureSettings(): PiWorkConfig | null {
  const settings = useSettings();
  useEffect(() => {
    if (state !== null) return;
    if (initialFetchStarted) return;
    initialFetchStarted = true;
    void fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PiWorkConfig | null) => {
        if (d) setSettings(d);
      })
      .catch(() => {
        // Leave state as null; consumers fall back to all-visible defaults.
        // Next page load will retry the fetch.
      });
  }, []);
  return settings;
}