"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";

interface SessionItemProps {
  session: SessionInfo;
  isSelected: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
  isFavorited?: boolean;
  onToggleFavorite?: () => void;
}

export function SessionItem({
  session,
  isSelected,
  onClick,
  onRenamed,
  onDeleted,
  isPinned = false,
  onTogglePin,
  isFavorited = false,
  onToggleFavorite,
}: SessionItemProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [hovered, setHovered] = useState(false);
  const [triggerHovered, setTriggerHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [menuVisible, setMenuVisible] = useState(false);
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

  // Drive the pop-in transition: when `menuOpen` flips to true, the portal
  // mounts in its pre-state (opacity 0, scale 0.96); the next animation
  // frame flips `menuVisible` to trigger the transition. Without rAF the
  // two setStates commit in the same batch and the transition never fires.
  useEffect(() => {
    if (!menuOpen) {
      setMenuVisible(false);
      return;
    }
    const id = requestAnimationFrame(() => setMenuVisible(true));
    return () => cancelAnimationFrame(id);
  }, [menuOpen]);

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
      toast.show({ kind: "error", message: err instanceof Error && err.message ? t("Failed to delete session") : String(err) });
    }
  }, [session.id, onDeleted, t, toast]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  // 36px matches Notion/Linear session rows: 13px title + 8px top/bottom padding
  // + ~1px border per side. Border 1px on every state (transparent in default)
  // so hover/selected don't cause layout shift. 8px corners + 6px gap (from
  // the list container) make this look like a real card, not a list row.
  const ITEM_HEIGHT = 36;

  // Selected / hover visual is now purely a background tint — no border ring,
  // no bold text. The shadow on selected keeps a subtle "lift" cue without
  // competing with neighbouring rows.
  const itemShadow = confirmDelete
    ? "none"
    : isSelected
      ? "0 1px 3px rgba(0,0,0,0.10)"
      : hovered
        ? "0 1px 2px rgba(0,0,0,0.06)"
        : "none";

  // Tab indent — applied to the inner content wrapper, NOT the outer row.
  // The row's hover / selected bg spans full width; only the visible text
  // (icons + title) is pushed right.
  const TEXT_INDENT_PX = 18;

  return (
    <div
      onClick={confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        // The list container is a flex column with overflow-y: auto, so this
        // row is a flex item. Default flex-shrink:1 makes 50+ rows share the
        // available height (each collapses to ~2px, e.g. /tmp with 395
        // sessions). flex-shrink:0 keeps every row at ITEM_HEIGHT and lets
        // the container scroll.
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 8,
        boxShadow: itemShadow,
        transition: "background 0.1s, box-shadow 0.15s",
        opacity: deleting ? 0.5 : 1,
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
                height: 28, padding: "0 10px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 11, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                height: 28, padding: "0 10px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 11, fontWeight: 500,
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
            padding: "4px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 28,
          }}
        />
      ) : (
        /* ── Normal view — wrapped in an inner content wrapper so the outer
            row's hover / selected bg spans full width while the text + icons
            sit indented by TEXT_INDENT_PX. ── */
        <div
          style={{
            flex: 1, minWidth: 0,
            display: "flex", alignItems: "center",
            paddingLeft: TEXT_INDENT_PX,
            paddingRight: 8,
            gap: 6,
            overflow: "hidden",
          }}
        >
          {/* Static pinned indicator — visible without hover so users can see pinned state at a glance */}
          {isPinned && (
            <span aria-hidden style={{ display: "flex", alignItems: "center", flexShrink: 0 }} title={t("Pinned sessions")}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="var(--accent)" stroke="none">
                <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2Z" />
              </svg>
            </span>
          )}
          {/* Static favorited indicator — visible without hover */}
          {isFavorited && (
            <span aria-hidden style={{ display: "flex", alignItems: "center", flexShrink: 0 }} title={t("Favorites")}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="var(--accent)" stroke="none">
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
                  width: 6,
                  height: 6,
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
                fontSize: 13,
                fontWeight: 400,
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
          </div>

          {/* "..." trigger — shown on row hover; toggles the action menu on click (no hover-open) */}
          {(hovered || triggerHovered || menuOpen) && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <button
                ref={triggerRef}
                aria-label={t("More actions")}
                onClick={(e) => { e.stopPropagation(); if (menuOpen) { cancelMenuClose(); setMenuOpen(false); } else { openMenu(); } }}
                onMouseEnter={() => { setTriggerHovered(true); cancelMenuClose(); }}
                onMouseLeave={() => { setTriggerHovered(false); if (menuOpen) scheduleMenuClose(); }}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 24, height: 24, padding: 0,
                  background: menuOpen ? "var(--bg-selected)" : "none",
                  border: menuOpen ? "1px solid color-mix(in srgb, var(--accent) 35%, transparent)" : "1px solid transparent",
                  borderRadius: 6,
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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" style={{ opacity: menuOpen ? 1 : 0.85 }}>
                  <circle cx="5" cy="12" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="19" cy="12" r="2" />
                </svg>
              </button>
            </div>
          )}
        </div>
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
            transformOrigin: "left top",
            opacity: menuVisible ? 1 : 0,
            transform: menuVisible
              ? "translateY(0) scale(1)"
              : "translateY(-6px) scale(0.96)",
            transition:
              "opacity 140ms ease-out, transform 160ms cubic-bezier(0.22, 1, 0.36, 1)",
            pointerEvents: menuVisible ? "auto" : "none",
          }}
        >
          {onTogglePin && (
            <MenuRow
              index={0}
              icon={<PinIcon filled={isPinned} />}
              label={isPinned ? t("Unpin session") : t("Pin session")}
              onClick={() => handleMenuItem(onTogglePin)}
            />
          )}
          {onToggleFavorite && (
            <MenuRow
              index={onTogglePin ? 1 : 0}
              icon={<StarIcon filled={isFavorited} />}
              label={isFavorited ? t("Unfavorite session") : t("Favorite session")}
              onClick={() => handleMenuItem(onToggleFavorite)}
            />
          )}
          <MenuRow
            index={(onTogglePin ? 1 : 0) + (onToggleFavorite ? 1 : 0)}
            icon={<PencilIcon />}
            label={t("Rename")}
            onClick={() => handleMenuItem(beginRename)}
          />
          <MenuRow
            index={(onTogglePin ? 1 : 0) + (onToggleFavorite ? 1 : 0) + 1}
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
  index = 0,
}: {
  icon: React.ReactNode;
  label: string;
  destructive?: boolean;
  onClick: () => void;
  index?: number;
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
        animation: "pi-menu-row-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both",
        animationDelay: `${40 + index * 28}ms`,
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