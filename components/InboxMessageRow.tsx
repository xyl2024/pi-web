"use client";

import { useI18n } from "@/hooks/useI18n";
import type { InboxMessage } from "@/hooks/useInbox";

const LEVEL_COLORS: Record<InboxMessage["level"], string> = {
  info: "var(--text-muted)",
  warn: "#f59e0b",
  error: "#ef4444",
};

function relativeTime(ts: number, t: (k: string) => string): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t("just now");
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ${t("ago")}`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ${t("ago")}`;
  return `${Math.floor(diff / 86_400_000)}d ${t("ago")}`;
}

function safeStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function InboxMessageRow({
  message,
  onDelete,
}: {
  message: InboxMessage;
  onDelete?: (id: string) => void;
}) {
  const { t } = useI18n();
  const payload = message.payload ?? {};
  const body = safeStr(payload.body);
  const href = safeStr(payload.href);

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
      }}
    >
      <div
        style={{
          width: 4,
          alignSelf: "stretch",
          background: LEVEL_COLORS[message.level],
          borderRadius: 2,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            marginBottom: 2,
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: "var(--text-dim)",
              fontWeight: 500,
              textTransform: "uppercase",
            }}
          >
            {message.source}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {relativeTime(message.ts, t)}
          </span>
        </div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text)",
            marginBottom: body || href ? 4 : 0,
          }}
        >
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              style={{ color: "inherit", textDecoration: "underline" }}
            >
              {message.title}
            </a>
          ) : (
            message.title
          )}
        </div>
        {body && (
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {body}
          </div>
        )}
      </div>
      {onDelete && (
        <button
          onClick={() => onDelete(message.id)}
          aria-label={t("Delete")}
          style={{
            alignSelf: "flex-start",
            background: "none",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            padding: 4,
            borderRadius: 4,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-dim)";
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}