"use client";

// Auto-naming toggle. Mirrors the sessionUiStore pattern: module-scoped state
// + useSyncExternalStore subscription + a stable setter that doesn't change
// identity between renders.
//
// The store holds the *current* enabled flag in memory. Persistence is the
// caller's job (SettingsModal and the command palette both PUT to
// /api/settings, then call setAutoNameEnabled to keep the store in sync).
//
// We start at the default (true) and hydrate from /api/settings on app
// mount via hydrateAutoNameEnabled() — called once from AppShell. The
// default is the same as config.yaml's default, so a brief flash of
// "enabled" before the GET resolves is harmless when the user has it off.

import { useSyncExternalStore } from "react";

let enabled = true;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribeAutoName(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): boolean {
  return enabled;
}

// Stable identity on the server to keep React happy during SSR/hydration.
function getServerSnapshot(): boolean {
  return true;
}

/** Set the in-memory flag. Does not persist — caller must PUT to /api/settings. */
export function setAutoNameEnabled(next: boolean) {
  if (next === enabled) return;
  enabled = next;
  emit();
}

/** Get the current in-memory flag without subscribing. Useful inside event handlers. */
export function getAutoNameEnabled(): boolean {
  return enabled;
}

/** Hook returning the current auto-naming enabled flag. */
export function useAutoNameEnabled(): boolean {
  return useSyncExternalStore(subscribeAutoName, getSnapshot, getServerSnapshot);
}

/**
 * One-shot hydration. Fetches /api/settings and updates the store if the
 * persisted value differs from the default. Safe to call multiple times —
 * it's a no-op once the value matches.
 */
export async function hydrateAutoNameEnabled(): Promise<void> {
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (!res.ok) return;
    const cfg = (await res.json()) as { auto_name_sessions?: unknown };
    if (typeof cfg.auto_name_sessions === "boolean") {
      setAutoNameEnabled(cfg.auto_name_sessions);
    }
  } catch {
    // Network failure is fine — the in-memory default is the right answer
    // for the common case, and the user can still toggle from the modal.
  }
}

/**
 * Persist a new value to /api/settings and update the store. Reads the
 * current config, modifies the auto_name_sessions field, and writes the
 * whole config back (the settings endpoint requires a full PiWebConfig
 * body). Returns the server response (or throws on network error).
 */
export async function persistAutoNameEnabled(next: boolean): Promise<void> {
  const getRes = await fetch("/api/settings", { cache: "no-store" });
  if (!getRes.ok) throw new Error(`GET settings failed: HTTP ${getRes.status}`);
  const cfg = await getRes.json();

  const putRes = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...cfg, auto_name_sessions: next }),
  });
  if (!putRes.ok) throw new Error(`PUT settings failed: HTTP ${putRes.status}`);
  setAutoNameEnabled(next);
}
