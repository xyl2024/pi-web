"use client";

import { useCallback, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { useConfirm } from "./ConfirmDialog";
import { useInbox, type InboxMessage } from "@/hooks/useInbox";
import { InboxMessageRow } from "./InboxMessageRow";

interface Props {
  open: boolean;
  onClose: () => void;
}

const TOOLBAR_BTN: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: "4px 10px",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--text-muted)",
  cursor: "pointer",
};

const CLOSE_BTN: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 20,
  lineHeight: 1,
  padding: "2px 8px",
};

type ClearMode = "all" | "source" | "older7d";

export function InboxModal({ open, onClose }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [refreshKey, setRefreshKey] = useState(0);
  const { messages, loading, error } = useInbox(open, refreshKey);

  const sources = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of messages) {
      counts.set(m.source, (counts.get(m.source) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({ source, count }));
  }, [messages]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(
          `/api/inbox/messages/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setRefreshKey((k) => k + 1);
      } catch (e) {
        toast.show({
          kind: "error",
          message:
            e instanceof Error && e.message ? e.message : t("Network error"),
        });
      }
    },
    [t, toast],
  );

  const performClear = useCallback(
    async (mode: ClearMode, source?: string) => {
      let url = "";
      let title = "";
      let description = "";
      let confirmLabel = t("Clear all");
      if (mode === "all") {
        title = t("Clear all messages?");
        description = t("This will permanently delete all inbox messages.");
        url = "/api/inbox/messages?all=1";
      } else if (mode === "source" && source) {
        title = t("Clear messages from {source}?").replace("{source}", source);
        description = t("This will permanently delete all messages from this source.");
        confirmLabel = t("Delete");
        url = `/api/inbox/messages?source=${encodeURIComponent(source)}`;
      } else {
        const ts = Date.now() - 7 * 86_400_000;
        title = t("Clear messages older than 7 days?");
        description = t("This will permanently delete old messages.");
        confirmLabel = t("Delete");
        url = `/api/inbox/messages?olderThan=${ts}`;
      }
      const ok = await confirm({ title, description, confirmLabel });
      if (!ok) return;
      try {
        const res = await fetch(url, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setRefreshKey((k) => k + 1);
        toast.show({ kind: "success", message: t("Cleared") });
      } catch (e) {
        toast.show({
          kind: "error",
          message:
            e instanceof Error && e.message ? e.message : t("Network error"),
        });
      }
    },
    [confirm, t, toast],
  );

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        style={{
          width: 720,
          maxWidth: "calc(100vw - 32px)",
          height: "80vh",
          maxHeight: "calc(100vh - 64px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
            {t("Inbox")}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => performClear("older7d")}
              style={TOOLBAR_BTN}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              {t("Clear older than 7 days")}
            </button>
            <button
              onClick={() => performClear("all")}
              style={{ ...TOOLBAR_BTN, color: "#ef4444" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              {t("Clear all")}
            </button>
            <button
              onClick={handleClose}
              style={{ ...CLOSE_BTN, marginLeft: 4 }}
              aria-label={t("Close")}
            >
              ×
            </button>
          </div>
        </div>

        {sources.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              padding: "10px 18px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            {sources.map(({ source, count }) => (
              <button
                key={source}
                onClick={() => performClear("source", source)}
                title={t("Clear messages from {source}").replace("{source}", source)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  color: "var(--text-muted)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg)";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <span style={{ fontWeight: 600 }}>{source}</span>
                <span style={{ color: "var(--text-dim)" }}>{count}</span>
              </button>
            ))}
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 18px" }}>
          {loading && messages.length === 0 && (
            <div
              style={{
                textAlign: "center",
                color: "var(--text-muted)",
                padding: 40,
              }}
            >
              {t("Loading...")}
            </div>
          )}
          {error && (
            <div style={{ textAlign: "center", color: "#ef4444", padding: 40 }}>
              {error}
            </div>
          )}
          {!loading && !error && messages.length === 0 && (
            <div
              style={{
                textAlign: "center",
                color: "var(--text-muted)",
                padding: 40,
              }}
            >
              {t("No messages")}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {messages.map((m: InboxMessage) => (
              <InboxMessageRow key={m.id} message={m} onDelete={handleDelete} />
            ))}
          </div>
        </div>

        <div
          style={{
            padding: "8px 18px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 11,
            color: "var(--text-dim)",
          }}
        >
          <span>{t("{n} messages").replace("{n}", String(messages.length))}</span>
          <span>{t("Auto-refresh every 5s")}</span>
        </div>
      </div>
    </div>
  );
}