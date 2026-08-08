"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo, Workspace } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { SessionItem } from "./SessionItem";
import { Tooltip } from "./Tooltip";

/**
 * Per-cwd session loader state. Held in a Map keyed by cwd so each group
 * can paginate independently without disturbing the others.
 */
export interface CwdSessionsState {
  sessions: SessionInfo[];
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  loadError: string | null;
}

interface MultiCwdListProps {
  /** Ordered list — active cwd first, then by lastUsed desc */
  workspaces: Workspace[];
  loadingWorkspaces: boolean;
  loadingMoreWorkspaces: boolean;
  hasMoreWorkspaces: boolean;
  workspaceLoadError: string | null;
  /** cwd → expanded (true) / collapsed (false). Caller owns persistence. */
  expandedCwds: Record<string, boolean>;
  /** cwd → session loader state */
  perCwdSessions: Record<string, CwdSessionsState>;
  /** Globally pinned session ids — pinned rows render above each group's
   "load more" tail regardless of cwd; rows are grouped under their own cwd. */
  pinnedSessions: string[];
  favoriteIds: string[];
  selectedSessionId: string | null;

  /** Tell the parent about cwd header refs so it can scrollIntoView on activate. */
  onCwdHeaderRef: (cwd: string, el: HTMLDivElement | null) => void;

  onToggleExpand: (cwd: string) => void;
  onSelectSession: (session: SessionInfo) => void;
  onLoadMoreWorkspaces: () => void;
  onLoadMoreCwdSessions: (cwd: string) => void;
  onTogglePin: (sessionId: string) => void;
  onToggleFavorite?: (sessionId: string) => void;
  onSessionRenamed: () => void;
  onSessionDeleted: (sessionId: string) => void;
  /** Called with the workspace cwd when the per-cwd "+" button is clicked.
   *  Wraps the parent-side new-session handler so the caller can decide
   *  which cwd wins regardless of the picker's active selection. */
  onNewSession?: (cwd: string) => void;
}

/**
 * Multi-cwd workspace list. Renders one CwdGroup per workspace, with the
 * active cwd pinned to the top. Each group is independently collapsible
 * (state owned by the parent — this component just renders + dispatches).
 */
export function MultiCwdList({
  workspaces,
  loadingWorkspaces,
  loadingMoreWorkspaces,
  hasMoreWorkspaces,
  workspaceLoadError,
  expandedCwds,
  perCwdSessions,
  pinnedSessions,
  favoriteIds,
  selectedSessionId,
  onCwdHeaderRef,
  onToggleExpand,
  onSelectSession,
  onLoadMoreWorkspaces,
  onLoadMoreCwdSessions,
  onTogglePin,
  onToggleFavorite,
  onSessionRenamed,
  onSessionDeleted,
  onNewSession,
}: MultiCwdListProps) {
  const { t } = useI18n();

  // Stable lookup for pinned sessions across all cwds in this list.
  const pinnedSessionSet = new Set(pinnedSessions);

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "4px 8px 8px", minHeight: 80, display: "flex", flexDirection: "column", gap: 8 }}>
      {loadingWorkspaces && workspaces.length === 0 && (
        <div style={{ padding: "16px 8px 6px", color: "var(--text-muted)", fontSize: 12 }}>
          {t("Loading projects...")}
        </div>
      )}
      {workspaceLoadError && !loadingWorkspaces && workspaces.length === 0 && (
        <div style={{ padding: "16px 8px 6px", color: "#f87171", fontSize: 12 }}>
          {workspaceLoadError}
        </div>
      )}
      {!loadingWorkspaces && !workspaceLoadError && workspaces.length === 0 && (
        <div style={{ padding: "16px 8px 6px", color: "var(--text-muted)", fontSize: 12 }}>
          {t("No projects yet")}
        </div>
      )}

      {workspaces.map((ws) => {
        // Default: every cwd is expanded on first load. localStorage retains
        // any prior collapsed state — first-writer-wins per cwd.
        const expanded = expandedCwds[ws.cwd] ?? true;
        const group = perCwdSessions[ws.cwd];
        // Sessions pinned to this cwd (insertion order preserved)
        const pinnedInCwd = pinnedSessions
          .map((id) => (group?.sessions ?? []).find((s) => s.id === id))
          .filter((s): s is SessionInfo => s !== undefined);
        // Pinned sessions might not be in the loaded page yet (lazy pagination).
        // We can't show them until the group has been loaded at least once.
        const hasUnloadedPinned = pinnedSessions.some(
          (id) => !pinnedInCwd.some((s) => s.id === id),
        );

        return (
          <CwdGroup
            key={ws.cwd}
            workspace={ws}
            expanded={expanded}
            group={group}
            pinnedInCwd={pinnedInCwd}
            hasUnloadedPinned={hasUnloadedPinned}
            pinnedSessionSet={pinnedSessionSet}
            favoriteIds={favoriteIds}
            selectedSessionId={selectedSessionId}
            onHeaderRef={(el) => onCwdHeaderRef(ws.cwd, el)}
            onToggleExpand={() => onToggleExpand(ws.cwd)}
            onSelectSession={onSelectSession}
            onLoadMoreSessions={() => onLoadMoreCwdSessions(ws.cwd)}
            onTogglePin={onTogglePin}
            onToggleFavorite={onToggleFavorite}
            onSessionRenamed={() => onSessionRenamed()}
            onSessionDeleted={onSessionDeleted}
            onNewSession={onNewSession}
          />
        );
      })}

      {hasMoreWorkspaces && (
        <button
          onClick={onLoadMoreWorkspaces}
          disabled={loadingMoreWorkspaces}
          style={{
            alignSelf: "center",
            padding: "5px 14px",
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text-muted)",
            cursor: loadingMoreWorkspaces ? "default" : "pointer",
            fontSize: 11,
            opacity: loadingMoreWorkspaces ? 0.6 : 1,
            marginTop: 2,
          }}
        >
          {loadingMoreWorkspaces ? t("Loading more...") : t("Load more projects")}
        </button>
      )}
      {!hasMoreWorkspaces && workspaces.length > 0 && (
        <div style={{ padding: "4px 8px 0", color: "var(--text-dim)", fontSize: 10, textAlign: "center" }}>
          {t("End of projects")}
        </div>
      )}
    </div>
  );
}

interface CwdGroupProps {
  workspace: Workspace;
  expanded: boolean;
  group: CwdSessionsState | undefined;
  pinnedInCwd: SessionInfo[];
  hasUnloadedPinned: boolean;
  pinnedSessionSet: Set<string>;
  favoriteIds: string[];
  selectedSessionId: string | null;

  onHeaderRef: (el: HTMLDivElement | null) => void;
  onToggleExpand: () => void;
  onSelectSession: (session: SessionInfo) => void;
  onLoadMoreSessions: () => void;
  onTogglePin: (sessionId: string) => void;
  onToggleFavorite?: (sessionId: string) => void;
  onSessionRenamed: () => void;
  onSessionDeleted: (sessionId: string) => void;
  onNewSession?: (cwd: string) => void;
}

function CwdGroup({
  workspace,
  expanded,
  group,
  pinnedInCwd,
  hasUnloadedPinned,
  pinnedSessionSet,
  favoriteIds,
  selectedSessionId,
  onHeaderRef,
  onToggleExpand,
  onSelectSession,
  onLoadMoreSessions,
  onTogglePin,
  onToggleFavorite,
  onSessionRenamed,
  onSessionDeleted,
  onNewSession,
}: CwdGroupProps) {
  const { t } = useI18n();
  const headerRef = useRef<HTMLDivElement | null>(null);

  // Forward the header DOM node to the parent so it can scrollIntoView when
  // the active cwd changes (e.g. via picker → list sync).
  useEffect(() => {
    onHeaderRef(headerRef.current);
    return () => onHeaderRef(null);
  }, [onHeaderRef]);

  const sessions = group?.sessions ?? [];
  // Non-pinned sessions, sorted by modified desc (the API already returns
  // them sorted, but re-sort here defensively for cross-cwd consistency).
  const nonPinnedSessions = sessions
    .filter((s) => !pinnedSessionSet.has(s.id))
    .slice()
    .sort((a, b) => b.modified.localeCompare(a.modified));

  // "..." menu state — mirrors SessionItem's pattern. The trigger button
  // (shown only on row hover) opens a portal'd menu panel on click.
  const [rowHovered, setRowHovered] = useState(false);
  const [triggerHovered, setTriggerHovered] = useState(false);
  const [loadMenuOpen, setLoadMenuOpen] = useState(false);
  const [loadMenuPos, setLoadMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [loadMenuVisible, setLoadMenuVisible] = useState(false);
  const loadMenuRef = useRef<HTMLDivElement | null>(null);
  const loadMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const showLoadMoreTrigger = group?.hasMore && (rowHovered || triggerHovered || loadMenuOpen);

  const cancelMenuClose = useCallback(() => {
    // no-op; kept for symmetry with SessionItem
  }, []);

  const openLoadMenu = useCallback(() => {
    cancelMenuClose();
    if (!loadMenuTriggerRef.current) return;
    const rect = loadMenuTriggerRef.current.getBoundingClientRect();
    setLoadMenuPos({ top: rect.top, left: rect.right + 6 });
    setLoadMenuOpen(true);
  }, [cancelMenuClose]);

  // Animate the menu in (matches SessionItem's rAF pattern).
  useEffect(() => {
    if (!loadMenuOpen) {
      setLoadMenuVisible(false);
      return;
    }
    const id = requestAnimationFrame(() => setLoadMenuVisible(true));
    return () => cancelAnimationFrame(id);
  }, [loadMenuOpen]);

  // Close the menu on outside mousedown / ESC / scroll / resize.
  useEffect(() => {
    if (!loadMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (loadMenuRef.current?.contains(target)) return;
      if (loadMenuTriggerRef.current?.contains(target)) return;
      cancelMenuClose();
      setLoadMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelMenuClose();
        setLoadMenuOpen(false);
      }
    };
    const onScroll = () => {
      cancelMenuClose();
      setLoadMenuOpen(false);
    };
    const onResize = () => {
      cancelMenuClose();
      setLoadMenuOpen(false);
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
  }, [loadMenuOpen, cancelMenuClose]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {/* Cwd header — plain row, no hover/active visual. Click anywhere on
          the row toggles expand/collapse. The right-side "…" trigger opens
          a portal menu (Load more sessions) modelled on SessionItem's menu
          pattern. */}
      <div
        ref={headerRef}
        onClick={onToggleExpand}
        onMouseEnter={() => setRowHovered(true)}
        onMouseLeave={() => setRowHovered(false)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleExpand(); } }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 6px 6px 4px",
          background: "transparent",
          borderRadius: 7,
          cursor: "pointer",
        }}
      >
        {/* Fold/unfold chevron — left side. Points down when expanded,
            right when collapsed (rotates -90deg). Pure visual indicator;
            clicking the header row toggles. */}
        <span
          aria-hidden
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 14, height: 22,
            color: "var(--text-dim)",
            flexShrink: 0,
            transition: "transform 0.15s",
            transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
          }}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2 4 5 7 8 4" />
          </svg>
        </span>

        {/* Path (no count, no tooltip) */}
        <span
          style={{
            flex: 1, minWidth: 0,
            display: "flex", alignItems: "center", gap: 6,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: 500,
          }}
        >
          <span style={{
            flex: 1, minWidth: 0,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {basenameOf(workspace.cwd)}
          </span>
          {workspace.runningCount > 0 && (
            <span
              title={t("running")}
              aria-label={t("running")}
              className="animate-[pulse_1.5s_infinite]"
              style={{
                width: 5, height: 5, borderRadius: "50%",
                background: "var(--accent)", flexShrink: 0,
              }}
            />
          )}
        </span>

        {/* "+" trigger — shown only on row hover (matches the existing "…"
            trigger pattern). Click creates a new session in this cwd
            without disturbing the picker's active selection. stopPropagation
            keeps the parent header click from also toggling expand. */}
        {onNewSession && rowHovered && (
          <Tooltip content={t("New session in this project")}>
            <button
              aria-label={t("New session in this project")}
              onClick={(e) => {
                e.stopPropagation();
                onNewSession(workspace.cwd);
              }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 22, height: 22, padding: 0, flexShrink: 0,
                background: "transparent",
                border: "1px solid transparent",
                borderRadius: 6,
                color: "var(--text-muted)",
                cursor: "pointer",
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="7" y1="2" x2="7" y2="12" />
                <line x1="2" y1="7" x2="12" y2="7" />
              </svg>
            </button>
          </Tooltip>
        )}

        {/* "…" trigger — shown on row hover or while menu is open. Mirrors
            SessionItem's row-hover trigger pattern. Click opens the menu. */}
        {showLoadMoreTrigger && (
          <button
            ref={loadMenuTriggerRef}
            aria-label={t("More actions")}
            onClick={(e) => {
              e.stopPropagation();
              if (loadMenuOpen) {
                setLoadMenuOpen(false);
              } else {
                openLoadMenu();
              }
            }}
            onMouseEnter={() => setTriggerHovered(true)}
            onMouseLeave={() => setTriggerHovered(false)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, padding: 0,
              background: loadMenuOpen ? "var(--bg-selected)" : "transparent",
              border: loadMenuOpen ? "1px solid color-mix(in srgb, var(--accent) 35%, transparent)" : "1px solid transparent",
              borderRadius: 6,
              color: loadMenuOpen ? "var(--accent)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
              transition: "background 0.12s, color 0.12s, border-color 0.12s",
            }}
            onMouseOver={(e) => {
              if (loadMenuOpen) return;
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseOut={(e) => {
              if (loadMenuOpen) return;
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" style={{ opacity: loadMenuOpen ? 1 : 0.85 }}>
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </button>
        )}

        {/* Menu panel via createPortal — same look as SessionItem's row menu. */}
        {loadMenuOpen && loadMenuPos && createPortal(
          <div
            ref={loadMenuRef}
            role="menu"
            style={{
              position: "fixed",
              top: loadMenuPos.top,
              left: loadMenuPos.left,
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
              transformOrigin: "left top",
              opacity: loadMenuVisible ? 1 : 0,
              transform: loadMenuVisible
                ? "translateY(0) scale(1)"
                : "translateY(-6px) scale(0.96)",
              transition:
                "opacity 140ms ease-out, transform 160ms cubic-bezier(0.22, 1, 0.36, 1)",
              pointerEvents: loadMenuVisible ? "auto" : "none",
            }}
          >
            {group?.hasMore && (
              <CwdMenuRow
                index={0}
                icon={<LoadMoreIcon />}
                label={group.loadingMore ? t("Loading more...") : t("Load more sessions")}
                disabled={group.loadingMore}
                onClick={() => {
                  setLoadMenuOpen(false);
                  onLoadMoreSessions();
                }}
              />
            )}
          </div>,
          document.body,
        )}
      </div>

      {/* Body: pinned sessions + recent sessions */}
      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 6 }}>
          {pinnedInCwd.length > 0 && (
            <>
              <div style={{ padding: "2px 6px 1px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                {t("Pinned sessions")}
              </div>
              {pinnedInCwd.map((s) => (
                <SessionItem
                  key={`pinned-${s.id}`}
                  session={s}
                  isSelected={s.id === selectedSessionId}
                  onClick={() => onSelectSession(s)}
                  onRenamed={onSessionRenamed}
                  onDeleted={(id) => onSessionDeleted(id)}
                  isPinned
                  onTogglePin={() => onTogglePin(s.id)}
                  isFavorited={favoriteIds.includes(s.id)}
                  onToggleFavorite={onToggleFavorite ? () => onToggleFavorite(s.id) : undefined}
                />
              ))}
            </>
          )}
          {hasUnloadedPinned && pinnedInCwd.length === 0 && group?.loading && (
            <div style={{ padding: "4px 6px", color: "var(--text-dim)", fontSize: 10 }}>
              {t("Loading pinned sessions...")}
            </div>
          )}

          {group?.loading && sessions.length === 0 && (
            <div style={{ padding: "10px 6px 4px", color: "var(--text-muted)", fontSize: 11 }}>
              {t("Loading sessions...")}
            </div>
          )}
          {group?.loadError && !group.loading && sessions.length === 0 && (
            <div style={{ padding: "10px 6px 4px", color: "#f87171", fontSize: 11 }}>
              {group.loadError}
            </div>
          )}
          {!group?.loading && sessions.length === 0 && !group?.loadError && (
            <div style={{ padding: "10px 6px 4px", color: "var(--text-dim)", fontSize: 11 }}>
              {t("No sessions found")}
            </div>
          )}

          {nonPinnedSessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              isSelected={s.id === selectedSessionId}
              onClick={() => onSelectSession(s)}
              onRenamed={onSessionRenamed}
              onDeleted={(id) => onSessionDeleted(id)}
              isPinned={pinnedSessionSet.has(s.id)}
              onTogglePin={() => onTogglePin(s.id)}
              isFavorited={favoriteIds.includes(s.id)}
              onToggleFavorite={onToggleFavorite ? () => onToggleFavorite(s.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function basenameOf(cwd: string): string {
  // Pick the separator that actually appears in the path. Windows uses
  // backslashes; POSIX uses slashes. If both are present (unusual but
  // legal on Windows after POSIX tools), prefer "/" so mixed paths render
  // sensibly. filter(Boolean) drops the empty leading segment produced by
  // absolute paths.
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  const parts = cwd.split(sep).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function CwdMenuRow({
  icon,
  label,
  onClick,
  disabled,
  index = 0,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  index?: number;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); if (!disabled) onClick(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 9px",
        borderRadius: 5,
        cursor: disabled ? "default" : "pointer",
        userSelect: "none",
        color: disabled ? "var(--text-dim)" : "var(--text)",
        background: hover && !disabled ? "var(--bg-hover)" : "transparent",
        animation: "pi-menu-row-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both",
        animationDelay: `${40 + index * 28}ms`,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, color: disabled ? "var(--text-dim)" : "var(--text-muted)", opacity: 0.85 }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
    </div>
  );
}

function LoadMoreIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}