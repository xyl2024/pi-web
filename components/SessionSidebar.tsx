"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "@/lib/types";
import { FileExplorer } from "./FileExplorer";
import { ProfileBlock } from "./ProfileBlock";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  initialSessionId?: string | null;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null) => void;
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

function formatRelativeTime(dateStr: string, t: ReturnType<typeof useI18n>["t"]): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return t("just now");
  if (mins < 60) return `${mins}m ${t("ago")}`;
  if (hours < 24) return `${hours}h ${t("ago")}`;
  if (days < 7) return `${days}d ${t("ago")}`;
  return date.toLocaleDateString();
}

function shortenCwd(cwd: string, homeDir?: string): string {
  const path = (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
  const sep = path.includes("/") ? "/" : "\\";
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= 2) return path;
  return "…/" + parts.slice(-2).join(sep);
}


interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
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

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "π";
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
        fontWeight: 700, fontSize: 24, marginTop: -7,
        color: showVersion ? "var(--accent)" : "var(--text)",
        minWidth: "3ch",
      }}
    >
      {display}
    </button>
  );
}

const PAGE_SIZE = 50;

export function SessionSidebar({ selectedSessionId, onSelectSession, initialSessionId, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onAtMention, onOpenSearch, onFileDeleted, favoriteIds = [], onToggleFavorite, onOpenModels, onOpenSkills, onOpenPrompts, onOpenScheduler, onOpenSettings, onOpenInbox, inboxUnread, profileRefreshKey }: Props) {
  const { t } = useI18n();
  const toast = useToast();

  // Paginated session list (replaces the old "load all then hold" design).
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const [createSpaceValue, setCreateSpaceValue] = useState("");
  const [createSpaceError, setCreateSpaceError] = useState<string | null>(null);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [pinnedCwds, setPinnedCwds] = useState<string[]>([]);
  const [pinnedSessions, setPinnedSessions] = useState<string[]>([]);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  const createSpaceInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerKey, setExplorerKey] = useState(0);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadListAbortRef = useRef<AbortController | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);

  const triggerExplorerRefresh = useCallback(() => {
    setExplorerKey((k) => k + 1);
    setExplorerRefreshDone(true);
    if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
    explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
  }, []);

  // Fetch a single page. Pass `mode: "reset"` to start over (cursor=null,
  // replace list), `mode: "append"` to extend the loaded list with the
  // page that follows `cursor` (or the start if cursor is null — first
  // page after a reset+refresh). Aborts any in-flight request so the
  // previous page's response can't land after a cwd switch / refresh.
  const fetchPage = useCallback(async (
    cursor: string | null,
    mode: "reset" | "append",
  ) => {
    loadListAbortRef.current?.abort();
    const controller = new AbortController();
    loadListAbortRef.current = controller;
    if (mode === "reset") setLoading(true);
    else setLoadingMore(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      if (cursor) params.set("cursor", cursor);
      if (selectedCwd) params.set("cwd", selectedCwd);
      const res = await fetch(`/api/sessions?${params.toString()}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        sessions: SessionInfo[];
        recentCwds: string[];
        nextCursor: string | null;
      };
      if (controller.signal.aborted) return;
      if (mode === "reset") {
        setSessions(data.sessions);
      } else {
        setSessions((prev) => {
          const seen = new Set(prev.map((s) => s.id));
          const incoming = data.sessions.filter((s) => !seen.has(s.id));
          return incoming.length === 0 ? prev : [...prev, ...incoming];
        });
      }
      setRecentCwds(data.recentCwds);
      setNextCursor(data.nextCursor);
      setHasMore(data.nextCursor !== null);
      if (mode === "reset") {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(msg);
      if (mode === "reset") {
        toast.show({ kind: "error", message: msg });
      }
    } finally {
      if (!controller.signal.aborted) {
        if (mode === "reset") setLoading(false);
        else setLoadingMore(false);
      }
    }
  }, [selectedCwd, toast]);

  // Initial / refresh / cwd-change: reset to page 1.
  useEffect(() => {
    void fetchPage(null, "reset");
  }, [fetchPage, refreshKey]);

  // Back-compat alias for inline rename/delete handlers that pre-date pagination.
  // They treat a successful mutation as "the sidebar should reflect the new
  // state", which maps cleanly to "go back to page 1 and show a green check".
  const loadSessions = useCallback(() => {
    void fetchPage(null, "reset");
  }, [fetchPage]);

  // Poll /api/sessions/running every 3s for the `running` flag on each row.
  // This endpoint only walks the in-memory AgentSessionWrapper registry — no
  // disk reads, so it's safe to poll at high frequency even with thousands
  // of session files. We only merge that single field into the loaded pages
  // — name/modified/etc. are owned by fetchPage() so polling preserves
  // scroll position, expanded parents, and hover state. Sessions that have
  // not been paginated in won't show a spinner until the user scrolls to
  // them (intentional — see design notes). Pauses while the tab is hidden;
  // resumes on visibilitychange.
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
        setSessions((prev) => prev.map((s) =>
          byRunning.has(s.id) ? { ...s, running: byRunning.get(s.id)! } : s
        ));
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

  // Infinite scroll: IntersectionObserver attached to the bottom sentinel
  // fetches the next page when it scrolls into view inside the list's own
  // overflow:auto scroller. Re-attaches whenever hasMore / nextCursor /
  // loading flags change so the closure stays current. `loadingMore` and
  // `loadError` prevent double-fires.
  useEffect(() => {
    const node = sentinelRef.current;
    const root = listScrollRef.current;
    if (!node || !root || !hasMore || loadError) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        if (loadingMore || loading) return;
        if (nextCursor) void fetchPage(nextCursor, "append");
      },
      { root, rootMargin: "120px 0px" }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [hasMore, nextCursor, loadingMore, loading, loadError, fetchPage]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

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

  useEffect(() => {
    onCwdChange?.(selectedCwd);
  }, [selectedCwd, onCwdChange]);

  // Auto-select cwd and restore session from URL on first load.
  // In paged mode the initial-session restore is best-effort: if the target
  // session is on a page we haven't fetched yet, fetch it via the lite info
  // endpoint and merge into the local list before resolving the cwd.
  useEffect(() => {
    if (sessions.length === 0 && !initialSessionId) return;
    if (selectedCwd !== null) return;

    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      const target = sessions.find((s) => s.id === initialSessionId);
      if (target) {
        setSelectedCwd(target.cwd);
        onSelectSession(target, true);
        return;
      }
      // Not on a loaded page — one-shot lite lookup.
      void (async () => {
        try {
          const res = await fetch(`/api/sessions/${encodeURIComponent(initialSessionId)}/info`);
          if (res.ok) {
            const data = (await res.json()) as { session: SessionInfo };
            setSessions((prev) => prev.find((s) => s.id === data.session.id) ? prev : [data.session, ...prev]);
            setSelectedCwd(data.session.cwd);
            onSelectSession(data.session, true);
            return;
          }
        } catch { /* fall through */ }
        onInitialRestoreDone?.();
      })();
      return;
    }

    if (recentCwds.length > 0) setSelectedCwd(recentCwds[0]);
  }, [sessions, recentCwds, selectedCwd, initialSessionId, onSelectSession, onInitialRestoreDone]);

  const commitCustomPath = useCallback(() => {
    const path = customPathValue.trim();
    if (path) {
      setSelectedCwd(path);
    }
    setCustomPathOpen(false);
    setCustomPathValue("");
    setCreateSpaceOpen(false);
    setCreateSpaceValue("");
    setCreateSpaceError(null);
    setDropdownOpen(false);
  }, [customPathValue]);

  const commitCreateSpace = useCallback(async () => {
    const dirName = createSpaceValue.trim();
    if (!dirName || creatingSpace) return;
    setCreatingSpace(true);
    setCreateSpaceError(null);
    try {
      const res = await fetch("/api/create-space", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir_name: dirName }),
      });
      const data = await res.json() as { cwd?: string; error?: string };
      if (!res.ok || !data.cwd) {
        setCreateSpaceError(data.error ?? `HTTP ${res.status}`);
        toast.show({ kind: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setSelectedCwd(data.cwd);
      setCreateSpaceOpen(false);
      setCreateSpaceValue("");
      setCreateSpaceError(null);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setDropdownOpen(false);
      setExplorerKey((k) => k + 1);
      toast.show({ kind: "success", message: t("Space created") });
    } catch (e) {
      setCreateSpaceError(String(e));
      toast.show({ kind: "error", message: String(e) });
    } finally {
      setCreatingSpace(false);
    }
  }, [createSpaceValue, creatingSpace, t, toast]);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        setDropdownOpen(false);
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCreateSpaceOpen(false);
        setCreateSpaceValue("");
        setCreateSpaceError(null);
      }
    } catch {
      // ignore
    }
  }, []);

  // Fetch pinned CWDs when dropdown opens
  useEffect(() => {
    if (!dropdownOpen) return;
    fetch("/api/pinned-cwds")
      .then((r) => r.json())
      .then((d: { cwds?: string[] }) => {
        if (Array.isArray(d.cwds)) setPinnedCwds(d.cwds);
      })
      .catch(() => {});
  }, [dropdownOpen]);

  const togglePin = useCallback(async (cwd: string) => {
    const next = pinnedCwds.includes(cwd)
      ? pinnedCwds.filter((p) => p !== cwd)
      : [...pinnedCwds, cwd];
    setPinnedCwds(next);
    try {
      await fetch("/api/pinned-cwds", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwds: next }),
      });
    } catch {
      // revert on failure
      setPinnedCwds(pinnedCwds);
      toast.show({ kind: "error", message: t("Failed to update pin") });
    }
  }, [pinnedCwds, t, toast]);

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

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCreateSpaceOpen(false);
        setCreateSpaceValue("");
        setCreateSpaceError(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const recentCwdsList = recentCwds;
  const pinnedSet = new Set(pinnedCwds);
  const unpinnedRecentCwds = recentCwdsList.filter((c) => !pinnedSet.has(c));
  const filteredSessions = selectedCwd
    ? sessions.filter((s) => s.cwd === selectedCwd)
    : sessions;

  // Pinned sessions in the current workspace, preserving insertion order.
  // find() returns undefined for stale ids (deleted sessions) or pins from other cwds — filtered out.
  const pinnedSessionSet = new Set(pinnedSessions);
  const pinnedSessionRows = selectedCwd
    ? pinnedSessions
        .map((id) => sessions.find((s) => s.id === id && s.cwd === selectedCwd))
        .filter((s): s is SessionInfo => s !== undefined)
    : [];

  // Build parent-child tree within the filtered set, excluding pinned sessions
  // (they're shown separately in the Pinned section above to avoid duplicate display).
  // Children of a pinned parent will become roots via buildSessionTree's resolveAncestor fallback.
  const sessionTree = buildSessionTree(
    filteredSessions.filter((s) => !pinnedSessionSet.has(s.id))
  );

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

        {/* CWD picker */}
        <div ref={dropdownRef} style={{ position: "relative" }}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              padding: "6px 10px",
              background: selectedCwd ? "var(--bg-hover)" : "rgba(37,99,235,0.06)",
              border: selectedCwd ? "1px solid var(--border)" : "1px solid rgba(37,99,235,0.4)",
              borderRadius: 7,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text)",
              textAlign: "left",
              transition: "border-color 0.15s, background 0.15s",
            }}
          >
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: selectedCwd ? "var(--text)" : "var(--text-dim)",
              }}
            >
              {selectedCwd ? shortenCwd(selectedCwd, homeDir) : (initialSessionId && !restoredRef.current ? "" : t("Select project..."))}
            </span>
          </button>

          {dropdownOpen && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                right: 0,
                zIndex: 100,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                overflow: "hidden",
              }}
            >
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {/* Pinned section */}
                {pinnedCwds.length > 0 && (
                  <>
                    <div style={{ padding: "6px 10px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      {t("Pinned")}
                    </div>
                    {pinnedCwds.map((cwd) => (
                      <Tooltip key={`pinned-${cwd}`} content={cwd}>
                      <button
                        onClick={() => {
                          setSelectedCwd(cwd);
                          setCustomPathOpen(false);
                          setCustomPathValue("");
                          setCreateSpaceOpen(false);
                          setCreateSpaceValue("");
                          setCreateSpaceError(null);
                          setDropdownOpen(false);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          width: "100%",
                          padding: "8px 10px",
                          background: cwd === selectedCwd ? "var(--bg-selected)" : "none",
                          border: "none",
                          borderBottom: "1px solid var(--border)",
                          color: cwd === selectedCwd ? "var(--text)" : "var(--text-muted)",
                          cursor: "pointer",
                          textAlign: "left",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <Tooltip content="Unpin">
                        <span
                          onClick={(e) => { e.stopPropagation(); togglePin(cwd); }}
                          style={{ display: "flex", alignItems: "center", flexShrink: 0, cursor: "pointer", padding: 2 }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--accent)" stroke="none">
                            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2Z" />
                          </svg>
                        </span>
                        </Tooltip>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortenCwd(cwd, homeDir)}</span>
                      </button>
                      </Tooltip>
                    ))}
                  </>
                )}

                {/* Recent section */}
                {unpinnedRecentCwds.length > 0 && (
                  <>
                    <div style={{ padding: pinnedCwds.length > 0 ? "4px 10px 3px" : "6px 10px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      {t("Recent")}
                    </div>
                    {unpinnedRecentCwds.map((cwd) => (
                      <Tooltip key={`recent-${cwd}`} content={cwd}>
                      <button
                        onClick={() => {
                          setSelectedCwd(cwd);
                          setCustomPathOpen(false);
                          setCustomPathValue("");
                          setCreateSpaceOpen(false);
                          setCreateSpaceValue("");
                          setCreateSpaceError(null);
                          setDropdownOpen(false);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          width: "100%",
                          padding: "8px 10px",
                          background: cwd === selectedCwd ? "var(--bg-selected)" : "none",
                          border: "none",
                          borderBottom: "1px solid var(--border)",
                          color: cwd === selectedCwd ? "var(--text)" : "var(--text-muted)",
                          cursor: "pointer",
                          textAlign: "left",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <Tooltip content="Pin">
                        <span
                          onClick={(e) => { e.stopPropagation(); togglePin(cwd); }}
                          style={{ display: "flex", alignItems: "center", flexShrink: 0, cursor: "pointer", padding: 2, opacity: 0.45 }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2Z" />
                          </svg>
                        </span>
                        </Tooltip>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortenCwd(cwd, homeDir)}</span>
                      </button>
                      </Tooltip>
                    ))}
                  </>
                )}
              </div>

              {/* Default cwd shortcut */}
              {!customPathOpen && !createSpaceOpen && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDefaultCwd(); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    borderTop: (pinnedCwds.length > 0 || unpinnedRecentCwds.length > 0) ? "1px solid var(--border)" : "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                  </svg>
                  <span>{t("Use default directory")}</span>
                </button>
              )}

              {/* Create space entry */}
              {!customPathOpen && !createSpaceOpen ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCreateSpaceOpen(true);
                    setCreateSpaceError(null);
                    setTimeout(() => createSpaceInputRef.current?.focus(), 0);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                    <line x1="5" y1="4.3" x2="5" y2="7.3" />
                    <line x1="3.5" y1="5.8" x2="6.5" y2="5.8" />
                  </svg>
                  <span>{t("Create space...")}</span>
                </button>
              ) : createSpaceOpen ? (
                <div style={{ padding: "6px 8px" }}>
                  <input
                    ref={createSpaceInputRef}
                    value={createSpaceValue}
                    onChange={(e) => {
                      setCreateSpaceValue(e.target.value);
                      setCreateSpaceError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitCreateSpace();
                      if (e.key === "Escape") {
                        setCreateSpaceOpen(false);
                        setCreateSpaceValue("");
                        setCreateSpaceError(null);
                      }
                    }}
                    placeholder={t("dir name")}
                    disabled={creatingSpace}
                    style={{
                      width: "100%",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      padding: "5px 8px",
                      border: "1px solid var(--accent)",
                      borderRadius: 5,
                      outline: "none",
                      background: "var(--bg)",
                      color: "var(--text)",
                      boxSizing: "border-box",
                    }}
                  />
                  {createSpaceError && (
                    <div style={{ marginTop: 5, color: "#f87171", fontSize: 11, lineHeight: 1.35 }}>
                      {createSpaceError}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                    <button
                      onClick={() => { void commitCreateSpace(); }}
                      disabled={creatingSpace || !createSpaceValue.trim()}
                      style={{
                        flex: 1,
                        padding: "4px 0",
                        background: "var(--accent)",
                        border: "none",
                        borderRadius: 5,
                        color: "#fff",
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: creatingSpace || !createSpaceValue.trim() ? "default" : "pointer",
                        opacity: creatingSpace || !createSpaceValue.trim() ? 0.6 : 1,
                      }}
                    >
                      {creatingSpace ? t("Creating...") : t("Create")}
                    </button>
                    <button
                      onClick={() => {
                        setCreateSpaceOpen(false);
                        setCreateSpaceValue("");
                        setCreateSpaceError(null);
                      }}
                      disabled={creatingSpace}
                      style={{
                        flex: 1,
                        padding: "4px 0",
                        background: "var(--bg-hover)",
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        color: "var(--text-muted)",
                        fontSize: 11,
                        cursor: creatingSpace ? "default" : "pointer",
                        opacity: creatingSpace ? 0.6 : 1,
                      }}
                    >
                      {t("Cancel")}
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Custom path entry */}
              {!customPathOpen && !createSpaceOpen ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCustomPathOpen(true);
                    setCreateSpaceOpen(false);
                    setCreateSpaceValue("");
                    setCreateSpaceError(null);
                    setTimeout(() => customPathInputRef.current?.focus(), 0);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                    <line x1="5" y1="1" x2="5" y2="9" />
                    <line x1="1" y1="5" x2="9" y2="5" />
                  </svg>
                  <span>{t("Custom path...")}</span>
                </button>
              ) : customPathOpen ? (
                <div style={{ padding: "6px 8px" }}>
                  <input
                    ref={customPathInputRef}
                    value={customPathValue}
                    onChange={(e) => setCustomPathValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitCustomPath();
                      if (e.key === "Escape") {
                        setCustomPathOpen(false);
                        setCustomPathValue("");
                      }
                    }}
                    placeholder="/path/to/project"
                    style={{
                      width: "100%",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      padding: "5px 8px",
                      border: "1px solid var(--accent)",
                      borderRadius: 5,
                      outline: "none",
                      background: "var(--bg)",
                      color: "var(--text)",
                      boxSizing: "border-box",
                    }}
                  />
                  <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                    <button
                      onClick={commitCustomPath}
                      style={{
                        flex: 1,
                        padding: "4px 0",
                        background: "var(--accent)",
                        border: "none",
                        borderRadius: 5,
                        color: "#fff",
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {t("Open")}
                    </button>
                    <button
                      onClick={() => { setCustomPathOpen(false); setCustomPathValue(""); }}
                      style={{
                        flex: 1,
                        padding: "4px 0",
                        background: "var(--bg-hover)",
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        color: "var(--text-muted)",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      {t("Cancel")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* Session list */}
      <div ref={listScrollRef} style={{ flex: explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto", overflowY: "auto", padding: "0", minHeight: 80 }}>
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("Loading...")}
          </div>
        )}
        {loadError && !loading && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {loadError}
          </div>
        )}
        {!loading && !loadError && sessions.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("No sessions found")}
          </div>
        )}
        {pinnedSessionRows.length > 0 && (
          <>
            <div style={{ padding: "8px 14px 4px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {t("Pinned sessions")}
            </div>
            {pinnedSessionRows.map((s) => (
              <SessionItem
                key={`pinned-${s.id}`}
                session={s}
                isSelected={s.id === selectedSessionId}
                onClick={() => onSelectSession(s)}
                onRenamed={loadSessions}
                onDeleted={(id) => { onSessionDeleted?.(id); loadSessions(); }}
                depth={0}
                isPinned
                onTogglePin={() => toggleSessionPin(s.id)}
                isFavorited={favoriteIds.includes(s.id)}
                onToggleFavorite={onToggleFavorite ? () => onToggleFavorite(s.id) : undefined}
              />
            ))}
          </>
        )}
        {sessionTree.map((node) => (
          <SessionTreeItem
            key={node.session.id}
            node={node}
            selectedSessionId={selectedSessionId}
            onSelectSession={onSelectSession}
            onRenamed={loadSessions}
            onSessionDeleted={(id) => {
              onSessionDeleted?.(id);
              loadSessions();
            }}
            depth={0}
            pinnedSessionSet={pinnedSessionSet}
            onTogglePin={toggleSessionPin}
            favoriteSet={new Set(favoriteIds)}
            onToggleFavorite={onToggleFavorite}
          />
        ))}

        {/* Pagination footer: end-of-list marker, in-flight spinner, or
            load-more retry button on a failed page fetch. */}
        {!loading && sessions.length > 0 && !hasMore && (
          <div style={{ padding: "10px 14px", color: "var(--text-dim)", fontSize: 11, textAlign: "center" }}>
            {t("End of sessions")}
          </div>
        )}
        {loadingMore && (
          <div style={{ padding: "10px 14px", color: "var(--text-muted)", fontSize: 11, textAlign: "center" }}>
            {t("Loading more...")}
          </div>
        )}
        {loadError && !loading && !loadingMore && (
          <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span style={{ color: "#f87171", fontSize: 11 }}>{loadError}</span>
            <button
              onClick={() => { setLoadError(null); void fetchPage(nextCursor, "append"); }}
              style={{
                fontSize: 11,
                padding: "3px 8px",
                border: "1px solid var(--border)",
                borderRadius: 5,
                background: "var(--bg-hover)",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              {t("Retry")}
            </button>
          </div>
        )}
        {/* IntersectionObserver sentinel — kept always rendered so the
            observer stays attached across page-append renders. */}
        {hasMore && <div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" />}
      </div>

      {/* File Explorer section */}
      {(selectedCwdProp || selectedCwd) && (
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
                cwd={selectedCwdProp ?? selectedCwd!}
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

function SessionTreeItem({
  node,
  selectedSessionId,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
  pinnedSessionSet,
  onTogglePin,
  favoriteSet,
  onToggleFavorite,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
  pinnedSessionSet: Set<string>;
  onTogglePin: (sessionId: string) => void;
  favoriteSet: Set<string>;
  onToggleFavorite?: (sessionId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          isPinned={pinnedSessionSet.has(node.session.id)}
          onTogglePin={() => onTogglePin(node.session.id)}
          isFavorited={favoriteSet.has(node.session.id)}
          onToggleFavorite={onToggleFavorite ? () => onToggleFavorite(node.session.id) : undefined}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
              pinnedSessionSet={pinnedSessionSet}
              onTogglePin={onTogglePin}
              favoriteSet={favoriteSet}
              onToggleFavorite={onToggleFavorite}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionItem({
  session,
  isSelected,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  isPinned = false,
  onTogglePin,
  isFavorited = false,
  onToggleFavorite,
}: {
  session: SessionInfo;
  isSelected: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
  isFavorited?: boolean;
  onToggleFavorite?: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [hovered, setHovered] = useState(false);
  const [triggerHovered, setTriggerHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelMenuClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleMenuClose = useCallback(() => {
    cancelMenuClose();
    closeTimerRef.current = setTimeout(() => setMenuOpen(false), 140);
  }, [cancelMenuClose]);

  const openMenu = useCallback(() => {
    cancelMenuClose();
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.top, left: rect.right + 6 });
    setMenuOpen(true);
  }, [cancelMenuClose]);

  const handleMenuItem = useCallback((fn?: () => void) => {
    cancelMenuClose();
    setMenuOpen(false);
    fn?.();
  }, [cancelMenuClose]);

  // Close on outside mousedown / ESC / scroll / resize while open
  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      cancelMenuClose();
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelMenuClose();
        setMenuOpen(false);
      }
    };
    const onScroll = () => {
      cancelMenuClose();
      setMenuOpen(false);
    };
    const onResize = () => {
      cancelMenuClose();
      setMenuOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen, cancelMenuClose]);

  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }, []);

  const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);

  const beginRename = useCallback(() => {
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onRenamed?.();
      toast.show({ kind: "success", message: t("Session renamed") });
    } catch (e) {
      toast.show({ kind: "error", message: e instanceof Error && e.message ? e.message : t("Failed to rename session") });
    }
  }, [renameValue, session.id, session.name, onRenamed, t, toast]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(true);
  }, []);

  const handleDeleteConfirm = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onDeleted?.(session.id);
      toast.show({ kind: "success", message: t("Session deleted") });
    } catch (err) {
      setDeleting(false);
      toast.show({ kind: "error", message: err instanceof Error && err.message ? err.message : t("Failed to delete session") });
    }
  }, [session.id, onDeleted, t, toast]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = 54;

  return (
    <div
      onClick={confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 14 : 14,
        paddingRight: 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: confirmDelete
          ? "2px solid #ef4444"
          : isSelected ? "2px solid var(--accent)" : "2px solid transparent",
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("Delete")} <span style={{ fontWeight: 600 }}>&ldquo;{title.slice(0, 22)}{title.length > 22 ? "…" : ""}&rdquo;</span>?
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("Delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("Cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Fork indicator for child sessions */}
          {depth > 0 && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          )}
          {/* Static pinned indicator — visible without hover so users can see pinned state at a glance */}
          {isPinned && (
            <span aria-hidden style={{ display: "flex", alignItems: "center", flexShrink: 0 }} title={t("Pinned sessions")}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="var(--accent)" stroke="none">
                <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2Z" />
              </svg>
            </span>
          )}
          {/* Static favorited indicator — visible without hover */}
          {isFavorited && (
            <span aria-hidden style={{ display: "flex", alignItems: "center", flexShrink: 0 }} title={t("Favorites")}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="var(--accent)" stroke="none">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </span>
          )}
          {/* Running indicator — pulses while the agent is between agent_start and agent_end */}
          {session.running && (
            <span
              aria-label={t("running")}
              title={t("running")}
              style={{ display: "flex", alignItems: "center", flexShrink: 0 }}
            >
              <span
                className="animate-[pulse_1.5s_infinite]"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "var(--accent)",
                }}
              />
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <Tooltip content={title}>
            <div
              style={{
                fontSize: 12,
                fontWeight: isSelected ? 500 : 400,
                lineHeight: 1.4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--text)",
              }}
            >
              {title}
            </div>
            </Tooltip>
            <div style={{ marginTop: 2, display: "flex", gap: 8, color: "var(--text-dim)", fontSize: 11 }}>
              <Tooltip content={session.modified}><span>{formatRelativeTime(session.modified, t)}</span></Tooltip>
              <span>{session.messageCount} {t("msgs")}</span>
            </div>
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <Tooltip content={collapsed ? t("Expand forks") : t("Collapse forks")}>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
            </Tooltip>
          )}

          {/* "..." trigger — shown on hover; opens an action menu */}
          {(hovered || triggerHovered || menuOpen) && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <Tooltip content={t("More actions")}>
                <button
                  ref={triggerRef}
                  aria-label={t("More actions")}
                  onClick={(e) => { e.stopPropagation(); if (menuOpen) { cancelMenuClose(); setMenuOpen(false); } else { openMenu(); } }}
                  onMouseEnter={() => { setTriggerHovered(true); cancelMenuClose(); if (!menuOpen) openMenu(); }}
                  onMouseLeave={() => { setTriggerHovered(false); if (menuOpen) scheduleMenuClose(); }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 26, padding: 0,
                    background: menuOpen ? "var(--bg-selected)" : "none",
                    border: menuOpen ? "1px solid rgba(37,99,235,0.35)" : "1px solid transparent",
                    borderRadius: 7,
                    color: menuOpen ? "var(--accent)" : "var(--text-muted)",
                    cursor: "pointer", flexShrink: 0,
                    transition: "background 0.12s, color 0.12s, border-color 0.12s",
                  }}
                  onMouseOver={(e) => {
                    if (menuOpen) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseOut={(e) => {
                    if (menuOpen) return;
                    e.currentTarget.style.background = "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" style={{ opacity: menuOpen ? 1 : 0.85 }}>
                    <circle cx="5" cy="12" r="2" />
                    <circle cx="12" cy="12" r="2" />
                    <circle cx="19" cy="12" r="2" />
                  </svg>
                </button>
              </Tooltip>
            </div>
          )}
        </>
      )}
      {menuOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          onMouseEnter={cancelMenuClose}
          onMouseLeave={scheduleMenuClose}
          role="menu"
          style={{
            position: "fixed",
            top: menuPos.top,
            left: menuPos.left,
            zIndex: 9999,
            minWidth: 168,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0,0,0,0.32)",
            padding: 4,
            display: "flex",
            flexDirection: "column",
            gap: 1,
            fontSize: 12,
            color: "var(--text)",
          }}
        >
          {onTogglePin && (
            <MenuRow
              icon={<PinIcon filled={isPinned} />}
              label={isPinned ? t("Unpin session") : t("Pin session")}
              onClick={() => handleMenuItem(onTogglePin)}
            />
          )}
          {onToggleFavorite && (
            <MenuRow
              icon={<StarIcon filled={isFavorited} />}
              label={isFavorited ? t("Unfavorite session") : t("Favorite session")}
              onClick={() => handleMenuItem(onToggleFavorite)}
            />
          )}
          <MenuRow
            icon={<PencilIcon />}
            label={t("Rename")}
            onClick={() => handleMenuItem(beginRename)}
          />
          <MenuRow
            icon={<TrashIcon />}
            label={t("Delete")}
            destructive
            onClick={() => handleMenuItem(() => handleDeleteClick({ stopPropagation: () => {} } as React.MouseEvent))}
          />
        </div>,
        document.body
      )}
    </div>
  );
}

function MenuRow({
  icon,
  label,
  destructive,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  destructive?: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 9px",
        borderRadius: 5,
        cursor: "pointer",
        userSelect: "none",
        color: destructive ? (hover ? "#fca5a5" : "#f87171") : "var(--text)",
        background: hover ? (destructive ? "rgba(239,68,68,0.10)" : "var(--bg-hover)") : "transparent",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, color: destructive ? "#ef4444" : "var(--text-muted)", opacity: destructive ? 0.95 : 0.85 }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
    </div>
  );
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2Z" />
    </svg>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
