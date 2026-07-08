"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { Tooltip } from "./Tooltip";
import { InboxBell } from "./InboxBell";

interface Props {
  onOpenSettings?: () => void;
  onOpenModels?: () => void;
  onOpenSkills?: () => void;
  onOpenPrompts?: () => void;
  onOpenScheduler?: () => void;
  onOpenInbox?: () => void;
  inboxUnread?: number;
  refreshKey?: number;
}

interface ProfileResponse {
  username: string | null;
}

const itemBaseStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "8px 10px",
  background: "none",
  border: "none",
  borderRadius: 6,
  color: "var(--text-muted)",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 12,
  fontWeight: 500,
};

export function ProfileBlock({ onOpenSettings, onOpenModels, onOpenSkills, onOpenPrompts, onOpenScheduler, onOpenInbox, inboxUnread, refreshKey }: Props) {
  const { t } = useI18n();
  const [username, setUsername] = useState<string | null>(null);
  const [avatarAttempted, setAvatarAttempted] = useState(0);
  const [avatarOk, setAvatarOk] = useState(false);
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/profile");
        if (!res.ok) {
          if (!cancelled) setUsername(null);
          return;
        }
        const data = (await res.json()) as ProfileResponse;
        if (!cancelled) setUsername(data.username);
      } catch {
        if (!cancelled) setUsername(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [refreshKey]);

  // Optimistically try to load the avatar on every refreshKey change.
  // If the server has no avatar (404), the onError handler clears avatarOk.
  useEffect(() => {
    setAvatarAttempted((n) => n + 1);
    setAvatarOk(true);
    setAvatarLoaded(false);
  }, [refreshKey]);

  // Close the menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const avatarSrc = `/api/profile/avatar?k=${encodeURIComponent(`${refreshKey ?? 0}-${avatarAttempted}`)}`;
  const showImg = avatarOk;
  const showPlaceholder = !avatarOk || !avatarLoaded;

  const hasAnyEntry = Boolean(onOpenModels || onOpenSkills || onOpenPrompts || onOpenScheduler);

  return (
    <div
      ref={wrapperRef}
      style={{
        position: "relative",
        padding: "8px 10px",
        borderTop: "1px solid var(--border)",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "var(--bg-panel)",
      }}
    >
      <button
        onClick={() => hasAnyEntry && setMenuOpen((v) => !v)}
        aria-label={t("Open quick menu")}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        disabled={!hasAnyEntry}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flex: 1,
          minWidth: 0,
          padding: 0,
          background: menuOpen ? "var(--bg-hover)" : "none",
          border: "none",
          borderRadius: 6,
          cursor: hasAnyEntry ? "pointer" : "default",
          opacity: 1,
          transition: "background 0.12s",
          textAlign: "left",
        }}
        onMouseEnter={(e) => { if (hasAnyEntry) e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { if (!menuOpen) e.currentTarget.style.background = "none"; }}
      >
        <div
          style={{
            width: 28, height: 28, flexShrink: 0,
            borderRadius: "50%", overflow: "hidden",
            background: "var(--bg-hover)",
            display: "flex", alignItems: "center", justifyContent: "center",
            border: "1px solid var(--border)",
          }}
        >
          {showImg && (
            <img
              key={avatarSrc}
              src={avatarSrc}
              alt=""
              onLoad={() => setAvatarLoaded(true)}
              onError={() => { setAvatarOk(false); setAvatarLoaded(false); }}
              style={{
                width: "100%", height: "100%", objectFit: "cover",
                display: avatarLoaded ? "block" : "none",
              }}
            />
          )}
          {showPlaceholder && (
            <svg
              width="15" height="15" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
              style={{ color: "var(--text-muted)" }}
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          )}
        </div>

        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            color: loading ? "var(--text-dim)" : "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: 500,
          }}
        >
          {loading ? "…" : (username ?? t("Guest"))}
        </span>
      </button>

      {onOpenInbox && (
        <InboxBell unread={inboxUnread ?? 0} onClick={onOpenInbox} />
      )}

      {onOpenSettings && (
        <Tooltip content={t("Settings")}>
          <button
            onClick={onOpenSettings}
            aria-label={t("Settings")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 28, height: 28, padding: 0, flexShrink: 0,
              background: "none",
              border: "none", borderRadius: 7,
              color: "var(--text-muted)", cursor: "pointer",
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </Tooltip>
      )}

      {menuOpen && hasAnyEntry && (
        <div
          role="menu"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: 10,
            minWidth: 160,
            zIndex: 100,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
            padding: 4,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {onOpenModels && (
            <button
              role="menuitem"
              onClick={() => { setMenuOpen(false); onOpenModels(); }}
              style={itemBaseStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <rect x="9" y="9" width="6" height="6" />
                <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
              </svg>
              <span>{t("Models")}</span>
            </button>
          )}
          {onOpenSkills && (
            <button
              role="menuitem"
              onClick={() => { setMenuOpen(false); onOpenSkills(); }}
              style={itemBaseStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
              <span>{t("Skills")}</span>
            </button>
          )}
          {onOpenPrompts && (
            <button
              role="menuitem"
              onClick={() => { setMenuOpen(false); onOpenPrompts(); }}
              style={itemBaseStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M4 19.5V4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 1 4 17.5" />
                <path d="M8 7h8" />
                <path d="M8 11h6" />
              </svg>
              <span>{t("Prompts")}</span>
            </button>
          )}
          {onOpenScheduler && (
            <button
              role="menuitem"
              onClick={() => { setMenuOpen(false); onOpenScheduler(); }}
              style={itemBaseStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 14" />
              </svg>
              <span>{t("Scheduled tasks")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}