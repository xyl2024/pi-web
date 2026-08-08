"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { SessionInfo, Workspace, WorkspacesResponse } from "@/lib/types";
import { FileExplorer } from "./FileExplorer";
import { ProfileBlock } from "./ProfileBlock";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { MultiCwdList, type CwdSessionsState } from "./MultiCwdList";

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  initialSessionId?: string | null;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  onNewSession?: (cwd?: string) => void;
  // cwd of the active chat context (selected session or in-flight new
  // session). The sidebar no longer renders an editable picker — this is
  // only consumed by FileExplorer + the top "+" button (canNew check).
  selectedCwd?: string | null;
  onOpenFile?: (filePath: string, fileName: string) => void;
  explorerRefreshKey?: number;
  onAtMention?: (filePath: string) => void;
  onOpenSearch?: () => void;
  onFileDeleted?: (filePath: string) => void;
  favoriteIds?: string[];
  onToggleFavorite?: (sessionId: string) => void;
  onOpenModels?: () => void;
  onOpenSkills?: () => void;
  onOpenPrompts?: () => void;
  onOpenScheduler?: () => void;
  onOpenSettings?: () => void;
  onOpenInbox?: () => void;
  inboxUnread?: number;
  profileRefreshKey?: number;
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

function PiAgentTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Pi Work";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "default",
        fontWeight: 700, fontSize: 18, letterSpacing: "-0.01em",
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        whiteSpace: "nowrap",
      }}
    >
      {display === "Pi Work" ? (
        <>P<span style={{ color: "var(--accent)" }}>i</span> W<span style={{ color: "var(--accent)" }}>o</span>rk</>
      ) : display}
    </button>
  );
}

const WORKSPACE_PAGE_SIZE = 5;
const SESSION_PAGE_SIZE_GROUPED = 5;
const EXPANDED_CWDS_KEY = "pi-work.expandedCwds";

export function SessionSidebar({ selectedSessionId, onSelectSession, initialSessionId, onInitialRestoreDone, refreshKey, onSessionDeleted, onNewSession, selectedCwd: selectedCwdProp, onOpenFile, explorerRefreshKey, onAtMention, onOpenSearch, onFileDeleted, favoriteIds = [], onToggleFavorite, onOpenModels, onOpenSkills, onOpenPrompts, onOpenScheduler, onOpenSettings, onOpenInbox, inboxUnread, profileRefreshKey }: Props) {
  const { t } = useI18n();
  const toast = useToast();

  // Multi-cwd view: workspaces list (top-level, cwd-keyed) + per-cwd
  // session loaders (lazy, paged 3 at a time).
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [nextWorkspaceCursor, setNextWorkspaceCursor] = useState<string | null>(null);
  const [hasMoreWorkspaces, setHasMoreWorkspaces] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [loadingMoreWorkspaces, setLoadingMoreWorkspaces] = useState(false);
  const [workspaceLoadError, setWorkspaceLoadError] = useState<string | null>(null);
  const [perCwdSessions, setPerCwdSessions] = useState<Record<string, CwdSessionsState>>({});
  // Expand state for non-active cwds; the active cwd defaults to expanded
  // when present. Persisted to localStorage.
  const [expandedCwds, setExpandedCwds] = useState<Record<string, boolean>>({});
  const cwdHeaderRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [pinnedSessions, setPinnedSessions] = useState<string[]>([]);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerKey, setExplorerKey] = useState(0);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceAbortRef = useRef<AbortController | null>(null);

  const triggerExplorerRefresh = useCallback(() => {
    setExplorerKey((k) => k + 1);
    setExplorerRefreshDone(true);
    if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
    explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
  }, []);

  // Persist expand state to localStorage. Stored as a flat object
  // { [cwd]: boolean } — last-writer-wins on the cwd key.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_CWDS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const cleaned: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "boolean") cleaned[k] = v;
      }
      setExpandedCwds(cleaned);
    } catch {
      // ignore corrupted entries
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_CWDS_KEY, JSON.stringify(expandedCwds));
    } catch {
      // ignore (private mode / quota)
    }
  }, [expandedCwds]);

  // Fetch one page of workspaces. Pass `mode: "reset"` to start over
  // (cursor=null, replace list), `mode: "append"` to extend. Aborts any
  // in-flight request so the previous page's response can't land after a
  // refresh.
  const fetchWorkspaces = useCallback(async (
    cursor: string | null,
    mode: "reset" | "append",
  ) => {
    workspaceAbortRef.current?.abort();
    const controller = new AbortController();
    workspaceAbortRef.current = controller;
    if (mode === "reset") setLoadingWorkspaces(true);
    else setLoadingMoreWorkspaces(true);
    setWorkspaceLoadError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(WORKSPACE_PAGE_SIZE));
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/workspaces?${params.toString()}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as WorkspacesResponse;
      if (controller.signal.aborted) return;
      if (mode === "reset") {
        setWorkspaces(data.workspaces);
      } else {
        setWorkspaces((prev) => {
          const seen = new Set(prev.map((w) => w.cwd));
          const incoming = data.workspaces.filter((w) => !seen.has(w.cwd));
          return incoming.length === 0 ? prev : [...prev, ...incoming];
        });
      }
      setNextWorkspaceCursor(data.nextCursor);
      setHasMoreWorkspaces(data.nextCursor !== null);
      if (mode === "reset") {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      setWorkspaceLoadError(msg);
      if (mode === "reset") {
        toast.show({ kind: "error", message: msg });
      }
    } finally {
      if (!controller.signal.aborted) {
        if (mode === "reset") setLoadingWorkspaces(false);
        else setLoadingMoreWorkspaces(false);
      }
    }
  }, [toast]);

  // Per-cwd session loader. Used both for the lazy first-page fetch
  // (mode: "reset") and the "Load more" button (mode: "append"). Reads
  // `pinnedSessions`/`expandedCwds` from state; merged into the existing
  // entry for the cwd.
  const fetchCwdSessions = useCallback(async (
    cwd: string,
    cursor: string | null,
    mode: "reset" | "append",
  ) => {
    setPerCwdSessions((prev) => {
      const existing = prev[cwd];
      const base: CwdSessionsState = existing ?? {
        sessions: [],
        cursor: null,
        hasMore: false,
        loading: false,
        loadingMore: false,
        loadError: null,
      };
      return {
        ...prev,
        [cwd]: {
          ...base,
          // Silent refresh: keep the current rows on reset (data still
          // shows while the request is in flight, no flash of the
          // "Loading sessions..." placeholder). The list is only replaced
          // once the fresh page arrives below.
          sessions: base.sessions,
          loading: mode === "reset",
          loadingMore: mode === "append",
          loadError: null,
        },
      };
    });

    try {
      const params = new URLSearchParams();
      params.set("cwd", cwd);
      params.set("limit", String(SESSION_PAGE_SIZE_GROUPED));
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/sessions?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sessions: SessionInfo[]; nextCursor: string | null };
      setPerCwdSessions((prev) => {
        const existing = prev[cwd];
        const base: CwdSessionsState = existing ?? {
          sessions: [],
          cursor: null,
          hasMore: false,
          loading: false,
          loadingMore: false,
          loadError: null,
        };
        const nextSessions = mode === "reset"
          ? data.sessions
          : (() => {
              const seen = new Set(base.sessions.map((s) => s.id));
              const incoming = data.sessions.filter((s) => !seen.has(s.id));
              return incoming.length === 0 ? base.sessions : [...base.sessions, ...incoming];
            })();
        return {
          ...prev,
          [cwd]: {
            ...base,
            sessions: nextSessions,
            cursor: data.nextCursor,
            hasMore: data.nextCursor !== null,
            loading: false,
            loadingMore: false,
          },
        };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPerCwdSessions((prev) => {
        const existing = prev[cwd];
        if (!existing) return prev;
        return {
          ...prev,
          [cwd]: { ...existing, loading: false, loadingMore: false, loadError: msg },
        };
      });
    }
  }, []);

  // Refresh button handler — reload workspaces + each expanded cwd's first page.
  const refreshAll = useCallback(() => {
    void fetchWorkspaces(null, "reset");
    setPerCwdSessions((prev) => {
      const next: Record<string, CwdSessionsState> = {};
      for (const [cwd, state] of Object.entries(prev)) {
        if (state.sessions.length > 0 || state.loading) {
          // Silent refresh: keep rows, just rewind to page 1 and refetch.
          next[cwd] = { ...state, cursor: null, hasMore: false };
          void fetchCwdSessions(cwd, null, "reset");
        } else {
          next[cwd] = state;
        }
      }
      return next;
    });
  }, [fetchWorkspaces, fetchCwdSessions]);

  // Back-compat alias used by inline rename/delete handlers that pre-date
  // the multi-cwd view: "the sidebar should reflect the new state" still
  // means "go back to page 1 and show a green check".
  const loadSessions = useCallback(() => {
    refreshAll();
  }, [refreshAll]);

  // refreshKey is bumped on session creation / rename / deletion / agent end.
  // Reload workspaces AND each loaded cwd's session page so renames and new
  // sessions show up in the sidebar immediately — fetchWorkspaces alone only
  // refreshes workspace-level metadata, not the per-cwd session rows (whose
  // name/modified come from /api/sessions?cwd=).
  useEffect(() => {
    refreshAll();
  }, [refreshKey, refreshAll]);

  // Auto-load: any cwd that enters the workspaces list AND is currently
  // expanded (default true) needs its first session page fetched. Tracking
  // via a ref avoids re-firing on every perCwdSessions tick — the effect
  // only does real work the first time a cwd appears or its expanded state
  // flips from false → true.
  const initializedCwdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const ws of workspaces) {
      if (initializedCwdsRef.current.has(ws.cwd)) continue;
      initializedCwdsRef.current.add(ws.cwd);
      const expanded = expandedCwds[ws.cwd] ?? true;
      if (!expanded) continue;
      const state = perCwdSessions[ws.cwd];
      if (state && (state.sessions.length > 0 || state.loading)) continue;
      void fetchCwdSessions(ws.cwd, null, "reset");
    }
  }, [workspaces, expandedCwds, perCwdSessions, fetchCwdSessions]);

  // Poll /api/sessions/running every 3s for the `running` flag on each row.
  // Merges into perCwdSessions — preserves scroll position + expand state.
  useEffect(() => {
    const POLL_INTERVAL_MS = 3000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const fetchRunning = async () => {
      try {
        const res = await fetch("/api/sessions/running");
        if (!res.ok) return;
        const data = (await res.json()) as { sessions: { id: string; running: boolean }[] };
        if (cancelled) return;
        const byRunning = new Map(data.sessions.map((s) => [s.id, s.running] as const));
        if (byRunning.size === 0) return;
        setPerCwdSessions((prev) => {
          let changed = false;
          const next: Record<string, CwdSessionsState> = {};
          for (const [cwd, state] of Object.entries(prev)) {
            let rowChanged = false;
            const rows = state.sessions.map((s) => {
              if (byRunning.has(s.id) && s.running !== byRunning.get(s.id)) {
                rowChanged = true;
                return { ...s, running: byRunning.get(s.id)! };
              }
              return s;
            });
            if (rowChanged) {
              changed = true;
              next[cwd] = { ...state, sessions: rows };
            } else {
              next[cwd] = state;
            }
          }
          return changed ? next : prev;
        });
      } catch {
        // best-effort
      }
    };

    const tick = () => {
      if (cancelled || document.hidden) return;
      fetchRunning().finally(() => {
        if (cancelled || document.hidden) return;
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      });
    };

    const onVisibility = () => {
      if (document.hidden || cancelled) return;
      if (timer) clearTimeout(timer);
      timer = null;
      tick();
    };

    document.addEventListener("visibilitychange", onVisibility);
    timer = setTimeout(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  // Fetch pinned sessions on mount (always-visible in main sidebar, not lazy-loaded)
  useEffect(() => {
    fetch("/api/pinned-sessions")
      .then((r) => r.json())
      .then((d: { sessionIds?: string[] }) => {
        if (Array.isArray(d.sessionIds)) setPinnedSessions(d.sessionIds);
      })
      .catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  // Auto-restore session from URL on first load.
  // In paged mode the initial-session restore is best-effort: if the target
  // session is on a page we haven't fetched yet, fetch it via the lite info
  // endpoint and merge into the perCwdSessions list before resolving.
  useEffect(() => {
    if (loadingWorkspaces) return;

    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      void (async () => {
        try {
          const res = await fetch(`/api/sessions/${encodeURIComponent(initialSessionId)}/info`);
          if (res.ok) {
            const data = (await res.json()) as { session: SessionInfo };
            // Merge into perCwdSessions so MultiCwdList can render the row.
            setPerCwdSessions((prev) => {
              const existing = prev[data.session.cwd];
              const base: CwdSessionsState = existing ?? {
                sessions: [],
                cursor: null,
                hasMore: false,
                loading: false,
                loadingMore: false,
                loadError: null,
              };
              const already = base.sessions.some((s) => s.id === data.session.id);
              if (already) return prev;
              return {
                ...prev,
                [data.session.cwd]: {
                  ...base,
                  sessions: [data.session, ...base.sessions],
                },
              };
            });
            onSelectSession(data.session, true);
            return;
          }
        } catch { /* fall through */ }
        onInitialRestoreDone?.();
      })();
    }
  }, [loadingWorkspaces, initialSessionId, onSelectSession, onInitialRestoreDone]);

  const toggleSessionPin = useCallback(async (sessionId: string) => {
    const next = pinnedSessions.includes(sessionId)
      ? pinnedSessions.filter((p) => p !== sessionId)
      : [...pinnedSessions, sessionId];
    setPinnedSessions(next);
    try {
      await fetch("/api/pinned-sessions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds: next }),
      });
    } catch {
      // revert on failure
      setPinnedSessions(pinnedSessions);
      toast.show({ kind: "error", message: t("Failed to update pin") });
    }
  }, [pinnedSessions, t, toast]);

  // Workspaces come pre-sorted by lastUsed desc from /api/workspaces;
  // no client-side reorder needed since the picker that previously
  // elevated the active cwd is gone.
  const orderedWorkspaces = workspaces;

  const toggleExpandCwd = useCallback((cwd: string) => {
    setExpandedCwds((prev) => {
      // Every cwd defaults to expanded; if absent in state, treat current
      // as true then flip.
      const current = prev[cwd] ?? true;
      return { ...prev, [cwd]: !current };
    });
  }, []);

  const handleToggleExpand = useCallback((cwd: string) => {
    toggleExpandCwd(cwd);
    // Session loading is handled by the auto-load useEffect above, which
    // fires whenever expandedCwds changes. No need to trigger here.
  }, [toggleExpandCwd]);

  const loadMoreCwdSessions = useCallback((cwd: string) => {
    const state = perCwdSessions[cwd];
    if (!state?.cursor) return;
    void fetchCwdSessions(cwd, state.cursor, "append");
  }, [perCwdSessions, fetchCwdSessions]);

  // Refresh both the workspace metadata (lastUsed may shift) and the
  // current cwd's session page (name may change) after a rename.
  const handleSessionRenamed = useCallback(() => {
    void fetchWorkspaces(null, "reset");
    if (selectedCwdProp) void fetchCwdSessions(selectedCwdProp, null, "reset");
  }, [fetchWorkspaces, fetchCwdSessions, selectedCwdProp]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    onSessionDeleted?.(sessionId);
    void fetchWorkspaces(null, "reset");
    if (selectedCwdProp) void fetchCwdSessions(selectedCwdProp, null, "reset");
  }, [onSessionDeleted, fetchWorkspaces, fetchCwdSessions, selectedCwdProp]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{
          padding: "12px 10px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <PiAgentTitle />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {onNewSession && (() => {
              const canNew = !!selectedCwdProp;
              return (
                <Tooltip content={t("New session")}>
                  <button
                    onClick={() => { onNewSession(); }}
                    disabled={!canNew}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      background: "rgba(37,99,235,0.08)",
                      border: "1px solid rgba(37,99,235,0.35)",
                      color: "var(--accent)",
                      cursor: canNew ? "pointer" : "not-allowed",
                      width: 32, height: 32,
                      borderRadius: 7,
                      padding: 0,
                      flexShrink: 0,
                      opacity: canNew ? 1 : 0.4,
                      transition: "opacity 0.12s, background 0.12s, border-color 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      if (!canNew) return;
                      e.currentTarget.style.background = "rgba(37,99,235,0.18)";
                      e.currentTarget.style.borderColor = "rgba(37,99,235,0.55)";
                    }}
                    onMouseLeave={(e) => {
                      if (!canNew) return;
                      e.currentTarget.style.background = "rgba(37,99,235,0.08)";
                      e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                      <line x1="7" y1="2" x2="7" y2="12" />
                      <line x1="2" y1="7" x2="12" y2="7" />
                    </svg>
                  </button>
                </Tooltip>
              );
            })()}
            <Tooltip content={t("Refresh")}>
            <button
              onClick={() => loadSessions()}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: sessionRefreshDone ? "rgba(74,222,128,0.18)" : "var(--bg-hover)",
                border: `1px solid ${sessionRefreshDone ? "rgba(74,222,128,0.4)" : "var(--border)"}`,
                color: sessionRefreshDone ? "#4ade80" : "var(--text-muted)",
                cursor: "pointer",
                width: 32, height: 32,
                borderRadius: 7,
                padding: 0,
                flexShrink: 0,
                transition: "background 0.3s, color 0.3s, border-color 0.3s",
              }}
              onMouseEnter={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              {sessionRefreshDone ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
            </Tooltip>
            {onOpenSearch && (
              <Tooltip content={`${t("Command palette")} (⌘K)`}>
              <button
                onClick={onOpenSearch}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  width: 32, height: 32,
                  borderRadius: 7,
                  padding: 0,
                  flexShrink: 0,
                  transition: "color 0.12s, background 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.background = "var(--bg-selected)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
              </Tooltip>
            )}
          </div>
        </div>
        </div>

      {/* Multi-cwd list: each CwdGroup renders its own pinned + recent
          sessions. The component owns the scroll container internally. */}
      <MultiCwdList
        workspaces={orderedWorkspaces}
        loadingWorkspaces={loadingWorkspaces}
        loadingMoreWorkspaces={loadingMoreWorkspaces}
        hasMoreWorkspaces={hasMoreWorkspaces}
        workspaceLoadError={workspaceLoadError}
        expandedCwds={expandedCwds}
        perCwdSessions={perCwdSessions}
        pinnedSessions={pinnedSessions}
        favoriteIds={favoriteIds}
        selectedSessionId={selectedSessionId}
        
        onCwdHeaderRef={(cwd, el) => { cwdHeaderRefs.current[cwd] = el; }}
        onToggleExpand={handleToggleExpand}
        onSelectSession={onSelectSession}
        onLoadMoreWorkspaces={() => { void fetchWorkspaces(nextWorkspaceCursor, "append"); }}
        onLoadMoreCwdSessions={loadMoreCwdSessions}
        onTogglePin={toggleSessionPin}
        onToggleFavorite={onToggleFavorite}
        onSessionRenamed={handleSessionRenamed}
        onSessionDeleted={handleSessionDeleted}
        onNewSession={onNewSession}
      />

      {/* File Explorer section */}
      {selectedCwdProp && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={() => setExplorerOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                padding: "6px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              >
                <polyline points="3 2 7 5 3 8" />
              </svg>
              {t("Explorer")}
            </button>
            <Tooltip content={t("Refresh explorer")}>
            <button
              onClick={triggerExplorerRefresh}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 26, height: 26, padding: 0, marginRight: 6,
                background: explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none",
                border: "none",
                color: explorerRefreshDone ? "#4ade80" : "var(--text-dim)",
                cursor: "pointer",
                borderRadius: 5,
                flexShrink: 0,
                transition: "color 0.3s, background 0.3s",
              }}
              onMouseEnter={(e) => { if (explorerRefreshDone) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { if (explorerRefreshDone) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
            >
              {explorerRefreshDone ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
            </Tooltip>
          </div>
          {explorerOpen && (
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              <FileExplorer
                cwd={selectedCwdProp!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onFileMutated={triggerExplorerRefresh}
                onFileDeleted={onFileDeleted}
              />
            </div>
          )}
        </div>
      )}

      {onOpenSettings && (
        <ProfileBlock
          onOpenSettings={onOpenSettings}
          onOpenModels={onOpenModels}
          onOpenSkills={onOpenSkills}
          onOpenPrompts={onOpenPrompts}
          onOpenScheduler={onOpenScheduler}
          onOpenInbox={onOpenInbox}
          inboxUnread={inboxUnread}
          refreshKey={profileRefreshKey}
        />
      )}
    </div>
  );
}

