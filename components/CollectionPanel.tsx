"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import type { SessionInfo } from "@/lib/types";

interface Props {
  favoriteIds: string[];
  onSelectSession: (session: SessionInfo) => void;
  onToggleFavorite: (sessionId: string) => void;
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

export function CollectionPanel({ favoriteIds, onSelectSession, onToggleFavorite }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[] };
      setAllSessions(data.sessions);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.show({ kind: "error", message: msg });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void reload(); }, [reload]);

  // Preserve favorite insertion order; drop stale ids (deleted or unfavorited elsewhere).
  const rows = useMemo(
    () => favoriteIds
      .map((id) => allSessions.find((s) => s.id === id))
      .filter((s): s is SessionInfo => s !== undefined),
    [favoriteIds, allSessions]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)" }}>
      {/* Header — title + count + refresh */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
          {t("Favorites")}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {favoriteIds.length} {t("sessions")}
        </span>
        <div style={{ flex: 1 }} />
        <Tooltip content={t("Refresh")}>
          <button
            onClick={() => void reload()}
            disabled={loading}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, padding: 0,
              background: "none", border: "none",
              color: loading ? "var(--text-dim)" : "var(--text-muted)",
              cursor: loading ? "default" : "pointer",
              borderRadius: 5,
              flexShrink: 0,
              transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => { if (loading) return; e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { if (loading) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "none"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </Tooltip>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px" }}>
        {loading && rows.length === 0 && (
          <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
            {t("Loading...")}
          </div>
        )}
        {error && (
          <div style={{ padding: "16px 12px", fontSize: 12, color: "#f87171", textAlign: "center" }}>
            {error}
            <div style={{ marginTop: 8 }}>
              <button
                onClick={() => void reload()}
                style={{
                  padding: "4px 12px",
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 5, color: "var(--text-muted)",
                  fontSize: 11, cursor: "pointer",
                }}
              >
                {t("Refresh")}
              </button>
            </div>
          </div>
        )}
        {!loading && !error && rows.length === 0 && (
          <div style={{
            padding: "32px 16px", fontSize: 12, color: "var(--text-dim)",
            textAlign: "center", display: "flex", flexDirection: "column",
            alignItems: "center", gap: 10,
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <div>{t("No favorites yet — click ☆ on any session to add it.")}</div>
          </div>
        )}
        {rows.map((s) => (
          <FavoriteRow
            key={s.id}
            session={s}
            onSelect={() => onSelectSession(s)}
            onRemove={() => onToggleFavorite(s.id)}
          />
        ))}
      </div>
    </div>
  );
}

function FavoriteRow({
  session,
  onSelect,
  onRemove,
}: {
  session: SessionInfo;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const title = session.name || session.firstMessage.slice(0, 60) || session.id.slice(0, 12);
  const cwdDisplay = session.cwd ? session.cwd.replace(/^\/home\/[^/]+/, "~") : "";

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 10px",
        margin: "2px 0",
        background: hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 6,
        cursor: "pointer",
        transition: "background 0.1s",
      }}
    >
      {/* Star icon — filled accent */}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--accent)" stroke="none" style={{ flexShrink: 0 }}>
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Tooltip content={title}>
          <div style={{
            fontSize: 12, fontWeight: 500,
            color: "var(--text)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {title}
          </div>
        </Tooltip>
        <div style={{ marginTop: 2, display: "flex", gap: 8, color: "var(--text-dim)", fontSize: 11 }}>
          <Tooltip content={session.cwd}>
            <span style={{
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              maxWidth: 140, fontFamily: "var(--font-mono)",
            }}>
              {cwdDisplay}
            </span>
          </Tooltip>
          <span style={{ flexShrink: 0 }}>{formatRelativeTime(session.modified, t)}</span>
          <span style={{ flexShrink: 0 }}>{session.messageCount} {t("msgs")}</span>
        </div>
      </div>
      {hovered && (
        <Tooltip content={t("Unfavorite session")}>
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            aria-label={t("Unfavorite session")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, padding: 0, flexShrink: 0,
              background: "transparent", border: "none",
              color: "var(--text-muted)", cursor: "pointer",
              borderRadius: 5,
              transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "#ef4444";
              e.currentTarget.style.background = "rgba(239,68,68,0.08)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-muted)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </Tooltip>
      )}
    </div>
  );
}