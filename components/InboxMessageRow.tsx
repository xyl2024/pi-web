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

interface ArticlesArticle {
  title?: unknown;
  link?: unknown;
}

interface ArticlesFeed {
  unreadCount?: unknown;
  feedTitle?: unknown;
  articles?: unknown;
}

interface ArticlesPayload {
  totalNew?: unknown;
  feedCount?: unknown;
  feeds?: unknown;
}

function safeNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function safeArray<T>(v: unknown): T[] | undefined {
  return Array.isArray(v) ? (v as T[]) : undefined;
}

/**
 * Parse the `payload.articles` field attached to per-tick RSS Inbox pushes
 * (see `lib/rss/loop.ts`). The shape is the same `feeds → articles`
 * structure the old daily digest used, just renamed — the renderer is the
 * one place that knows how to draw a structured article list inline.
 */
function parseArticlesPayload(payload: unknown): {
  feeds: Array<{ unreadCount: number; feedTitle: string | null; articles: Array<{ title: string; link: string }> }>;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as ArticlesPayload;
  const feedsRaw = safeArray<ArticlesFeed>(obj.feeds);
  if (!feedsRaw) return null;
  const feeds = feedsRaw.map((f) => {
    const articlesRaw = safeArray<ArticlesArticle>(f.articles) ?? [];
    const articles = articlesRaw
      .map((a) => ({
        title: safeStr(a.title) ?? "",
        link: safeStr(a.link) ?? "",
      }))
      .filter((a) => a.link.length > 0);
    return {
      unreadCount: safeNumber(f.unreadCount) ?? 0,
      feedTitle: safeStr(f.feedTitle) ?? null,
      articles,
    };
  });
  return { feeds };
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
  const articlesList = parseArticlesPayload(payload.articles);

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
        {articlesList && articlesList.feeds.length > 0 && (
          <div
            style={{
              marginTop: 6,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {articlesList.feeds.map((feed, i) => (
              <div
                key={i}
                style={{
                  fontSize: 12,
                  color: "var(--text)",
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    marginBottom: 2,
                    color: "var(--text-muted)",
                  }}
                >
                  {feed.feedTitle ?? t("(untitled)")} · {feed.unreadCount}
                </div>
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  {feed.articles.map((art, j) => (
                    <li key={j}>
                      <a
                        href={art.link}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          color: "var(--text)",
                          textDecoration: "none",
                          display: "block",
                          padding: "2px 0",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.textDecoration = "underline";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.textDecoration = "none";
                        }}
                      >
                        · {art.title || art.link}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
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