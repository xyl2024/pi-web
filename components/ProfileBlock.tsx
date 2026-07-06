"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { Tooltip } from "./Tooltip";

interface Props {
  onOpenSettings: () => void;
  refreshKey?: number;
}

interface ProfileResponse {
  username: string | null;
}

export function ProfileBlock({ onOpenSettings, refreshKey }: Props) {
  const { t } = useI18n();
  const [username, setUsername] = useState<string | null>(null);
  const [avatarAttempted, setAvatarAttempted] = useState(0);
  const [avatarOk, setAvatarOk] = useState(false);
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  const [loading, setLoading] = useState(true);

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

  const avatarSrc = `/api/profile/avatar?k=${encodeURIComponent(`${refreshKey ?? 0}-${avatarAttempted}`)}`;
  const showImg = avatarOk;
  const showPlaceholder = !avatarOk || !avatarLoaded;

  return (
    <div
      style={{
        padding: "8px 10px",
        borderTop: "1px solid var(--border)",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "var(--bg-panel)",
      }}
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

      <div
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
      </div>

      <Tooltip content={t("Settings")}>
        <button
          onClick={onOpenSettings}
          aria-label={t("Settings")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 28, height: 28, padding: 0, flexShrink: 0,
            background: "none", border: "none", borderRadius: 7,
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
    </div>
  );
}