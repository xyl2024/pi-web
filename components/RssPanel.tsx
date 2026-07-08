"use client";

/**
 * Right-panel tab body for the RSS feature.
 *
 * Single-column layout that switches between three views, owned by
 * `useRss().view`:
 *
 *   - feeds:    list of subscribed feeds with unread badges + per-row actions
 *   - articles: article list for one feed, sorted newest first
 *   - reader:   single-article HTML viewer with a "Mark all as read" /
 *               "Open original" affordances
 *
 * State management, fetch, and view navigation live in `hooks/useRss.ts`.
 * Sanitization is `lib/rss-sanitize.ts` (DOMPurify, run at render time so the
 * store keeps the raw HTML).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import parseHtml, { domToReact, type DOMNode, type Element, type HTMLReactParserOptions } from "html-react-parser";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useRss } from "@/hooks/useRss";
import { useRssDigestSettings } from "@/hooks/useRssDigestSettings";
import { sanitizeRssHtml } from "@/lib/rss-sanitize";
import { ImageLightbox, extractImagesFromHtml, type ImageItem } from "@/components/ImageLightbox";
import type { RssArticle, RssFeed } from "@/lib/rss-schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(ts: number | null, fallback: string): string {
  if (!ts) return fallback;
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ts).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function RssPanel(): ReactElement {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const rss = useRss();

  const [adding, setAdding] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // When we land in the reader view, lazily ensure articles for that feed are
  // loaded so the cache is warm when the user clicks Back.
  useEffect(() => {
    const v = rss.view;
    if (v.kind === "articles" || v.kind === "reader") {
      if (!rss.articlesByFeed[v.feedId]) {
        void rss.loadArticles(v.feedId).catch(() => {
          /* error already captured by the hook */
        });
      }
    }
    // rss.loadArticles is stable from useCallback; rss as a whole changes
    // identity on every render and would re-fire this effect needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rss.view, rss.articlesByFeed, rss.loadArticles]);

  // Auto-mark read when entering the reader view.
  useEffect(() => {
    const v = rss.view;
    if (v.kind !== "reader") return;
    const articles = rss.articlesByFeed[v.feedId] ?? [];
    const article = articles.find((a) => a.id === v.articleId);
    if (article && article.readAt === null) {
      void rss.markArticleRead(article.id, true).catch(() => {
        /* swallow — the cache will sync on next refetch */
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rss.view, rss.articlesByFeed, rss.markArticleRead]);

  const handleAdd = useCallback(async () => {
    const url = newUrl.trim();
    if (!url) return;
    if (submitting) return;
    setSubmitting(true);
    try {
      await rss.addFeed({ url });
      setNewUrl("");
      setAdding(false);
      toast.show({ kind: "success", message: t("Feed added") });
    } catch (e) {
      toast.show({
        kind: "error",
        message: `${t("Failed to add feed")}: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [newUrl, rss, submitting, t, toast]);

  const handleRefreshAll = useCallback(async () => {
    if (rss.feeds.length === 0) {
      toast.show({ kind: "info", message: t("No feeds yet") });
      return;
    }
    await Promise.all(
      rss.feeds.map((f) =>
        rss.refreshFeed(f.id).catch(() => null),
      ),
    );
    toast.show({ kind: "success", message: t("Refreshed") });
  }, [rss, t, toast]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const view = rss.view;
  const feed =
    view.kind === "feeds"
      ? null
      : rss.feeds.find((f) => f.id === view.feedId) ?? null;
  const article =
    view.kind === "reader"
      ? (rss.articlesByFeed[view.feedId] ?? []).find(
          (a) => a.id === view.articleId,
        ) ?? null
      : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg)",
        color: "var(--text)",
      }}
    >
      <RssHeaderBar
        view={rss.view}
        feedTitle={feed?.title ?? null}
        navigate={rss.navigate}
        onAdd={() => setAdding(true)}
        onRefreshAll={handleRefreshAll}
        adding={adding}
        cancelAdd={() => {
          setAdding(false);
          setNewUrl("");
        }}
        newUrl={newUrl}
        setNewUrl={setNewUrl}
        submitting={submitting}
        onSubmitAdd={handleAdd}
        t={t}
      />

      {rss.view.kind === "feeds" && <RssDigestBar t={t} toast={toast} />}

      {adding && (
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          {t("Add feed URL")}
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto", padding: "0 0 16px" }}>
        {rss.view.kind === "feeds" && (
          <FeedsView
            feeds={rss.feeds}
            isLoading={rss.isLoading}
            onOpen={(id) => rss.navigate({ kind: "articles", feedId: id })}
            onRefresh={async (id) => {
              try {
                const result = await rss.refreshFeed(id);
                if (result && !result.ok) {
                  toast.show({
                    kind: "error",
                    message: `${t("Refresh failed")}: ${result.error ?? ""}`,
                  });
                } else {
                  toast.show({ kind: "success", message: t("Refreshed") });
                }
              } catch (e) {
                toast.show({
                  kind: "error",
                  message: `${t("Failed to refresh feed")}: ${e instanceof Error ? e.message : String(e)}`,
                });
              }
            }}
            onDelete={async (id) => {
              const f = rss.feeds.find((x) => x.id === id);
              const ok = await confirm({
                title: t("Delete feed?"),
                description: f?.title ?? f?.url ?? "",
                destructive: true,
                confirmLabel: t("Delete"),
              });
              if (!ok) return;
              try {
                await rss.removeFeed(id);
                toast.show({ kind: "success", message: t("Feed deleted") });
              } catch (e) {
                toast.show({
                  kind: "error",
                  message: `${t("Failed to delete feed")}: ${e instanceof Error ? e.message : String(e)}`,
                });
              }
            }}
            t={t}
          />
        )}

        {view.kind === "articles" && (
          <ArticlesView
            feed={feed}
            articles={rss.articlesByFeed[view.feedId] ?? []}
            onOpen={(articleId) =>
              rss.navigate({ kind: "reader", feedId: view.feedId, articleId })
            }
            onMarkAll={async () => {
              if (!feed) return;
              try {
                await rss.markAllFeedRead(feed.id);
                toast.show({
                  kind: "success",
                  message: t("Marked all as read"),
                });
              } catch (e) {
                toast.show({
                  kind: "error",
                  message: `${t("Failed to mark articles as read")}: ${e instanceof Error ? e.message : String(e)}`,
                });
              }
            }}
            t={t}
          />
        )}

        {rss.view.kind === "reader" && feed && (
          <ReaderView
            feed={feed}
            article={article}
            onBack={() =>
              rss.navigate({ kind: "articles", feedId: feed.id })
            }
            t={t}
          />
        )}

        {rss.view.kind === "reader" && !feed && (
          <div style={emptyStyle}>{t("Feed not found")}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Digest bar (daily digest status + settings)
// ---------------------------------------------------------------------------

interface RssDigestBarProps {
  t: (k: string) => string;
  toast: ReturnType<typeof useToast>;
}

function RssDigestBar({ t, toast }: RssDigestBarProps): ReactElement {
  const digest = useRssDigestSettings();
  const [expanded, setExpanded] = useState(false);
  const [hour, setHour] = useState<string>("9");
  const [minute, setMinute] = useState<string>("0");
  const [minUnread, setMinUnread] = useState<string>("1");
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const lastSeenSettings = useRef<string>("");

  // Sync local form state once the API responds.
  useEffect(() => {
    if (!digest.settings) return;
    const s = digest.settings;
    const sig = `${s.enabled}|${s.hour}|${s.minute}|${s.minUnread}`;
    if (sig === lastSeenSettings.current) return;
    lastSeenSettings.current = sig;
    setEnabled(s.enabled);
    setHour(String(s.hour));
    setMinute(String(s.minute));
    setMinUnread(String(s.minUnread));
  }, [digest.settings]);

  const statusText = useMemo(() => {
    if (!digest.settings) return t("Loading…");
    if (!digest.settings.enabled) return t("Daily digest is off");
    const next = digest.settings.nextRunAt;
    if (!next) return t("Daily digest is off");
    const d = new Date(next);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return t("Next digest at {time}").replace("{time}", `${hh}:${mm}`);
  }, [digest.settings, t]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    const hourNum = Number.parseInt(hour, 10);
    const minuteNum = Number.parseInt(minute, 10);
    const minUnreadNum = Number.parseInt(minUnread, 10);
    if (
      !Number.isFinite(hourNum) ||
      hourNum < 0 ||
      hourNum > 23 ||
      !Number.isFinite(minuteNum) ||
      minuteNum < 0 ||
      minuteNum > 59 ||
      !Number.isFinite(minUnreadNum) ||
      minUnreadNum < 1
    ) {
      toast.show({
        kind: "error",
        message: t("Invalid digest settings"),
      });
      return;
    }
    setSaving(true);
    try {
      await digest.update({
        enabled,
        hour: hourNum,
        minute: minuteNum,
        minUnread: minUnreadNum,
      });
      toast.show({ kind: "success", message: t("Saved") });
      setExpanded(false);
    } catch (e) {
      toast.show({
        kind: "error",
        message: `${t("Save failed")}: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setSaving(false);
    }
  }, [digest, enabled, hour, minute, minUnread, saving, t, toast]);

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          fontSize: 12,
          color: "var(--text-muted)",
          minHeight: 32,
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: digest.settings?.enabled
              ? "var(--accent)"
              : "var(--text-dim)",
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {statusText}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            ...iconBtnStyle,
            fontSize: 12,
            padding: "2px 8px",
          }}
          aria-expanded={expanded}
          title={t("Daily digest")}
        >
          ⚙
        </button>
      </div>
      {expanded && (
        <div
          style={{
            padding: "8px 12px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            borderTop: "1px solid var(--border)",
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--text)",
            }}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>{t("Enable daily digest")}</span>
          </label>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--text)",
            }}
          >
            <span style={{ minWidth: 60 }}>{t("Time")}</span>
            <input
              type="time"
              value={`${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":");
                setHour(h ?? "0");
                setMinute(m ?? "0");
              }}
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                color: "var(--text)",
                padding: "2px 6px",
                fontSize: 12,
              }}
            />
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--text)",
            }}
          >
            <span style={{ minWidth: 60 }}>{t("Minimum unread")}</span>
            <input
              type="number"
              min={1}
              step={1}
              value={minUnread}
              onChange={(e) => setMinUnread(e.target.value)}
              style={{
                width: 80,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                color: "var(--text)",
                padding: "2px 6px",
                fontSize: 12,
              }}
            />
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              style={{ ...iconBtnStyle, fontSize: 12, padding: "2px 10px" }}
            >
              {t("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                ...iconBtnStyle,
                fontSize: 12,
                padding: "2px 10px",
                opacity: saving ? 0.5 : 1,
              }}
            >
              {t("Save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

interface RssHeaderBarProps {
  view: ReturnType<typeof useRss>["view"];
  feedTitle: string | null;
  navigate: ReturnType<typeof useRss>["navigate"];
  onAdd: () => void;
  onRefreshAll: () => void;
  adding: boolean;
  cancelAdd: () => void;
  newUrl: string;
  setNewUrl: (v: string) => void;
  submitting: boolean;
  onSubmitAdd: () => void;
  t: (k: string) => string;
}

function RssHeaderBar({
  view,
  feedTitle,
  navigate,
  onAdd,
  onRefreshAll,
  adding,
  cancelAdd,
  newUrl,
  setNewUrl,
  submitting,
  onSubmitAdd,
  t,
}: RssHeaderBarProps): ReactElement {
  const backLabel =
    view.kind === "reader"
      ? t("Back to articles")
      : view.kind === "articles"
        ? t("Back to feeds")
        : null;
  const titleLabel =
    view.kind === "feeds"
      ? t("RSS feeds")
      : view.kind === "articles"
        ? feedTitle ?? t("Articles")
        : feedTitle ?? t("Articles");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
        }}
      >
        {backLabel && (
          <button
            type="button"
            onClick={() => {
              if (view.kind === "reader") {
                navigate({ kind: "articles", feedId: view.feedId });
              } else if (view.kind === "articles") {
                navigate({ kind: "feeds" });
              }
            }}
            style={iconBtnStyle}
            title={backLabel}
          >
            ←
          </button>
        )}
        <div
          style={{
            flex: 1,
            fontWeight: 600,
            fontSize: 13,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {titleLabel}
        </div>
        {view.kind === "feeds" && (
          <button type="button" onClick={onRefreshAll} style={iconBtnStyle} title={t("Refresh all")}>
            ↻
          </button>
        )}
        {view.kind === "feeds" && (
          <button type="button" onClick={onAdd} style={iconBtnStyle} title={t("Add RSS feed")}>
            +
          </button>
        )}
      </div>

      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmitAdd();
          }}
          style={{
            display: "flex",
            gap: 6,
            padding: "0 12px 8px",
          }}
        >
          <input
            autoFocus
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://example.com/feed.xml"
            style={{
              flex: 1,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text)",
              padding: "4px 8px",
              fontSize: 12,
            }}
          />
          <button
            type="submit"
            disabled={submitting || newUrl.trim().length === 0}
            style={{
              ...iconBtnStyle,
              opacity: submitting || newUrl.trim().length === 0 ? 0.5 : 1,
            }}
          >
            {t("Add")}
          </button>
          <button type="button" onClick={cancelAdd} style={iconBtnStyle}>
            {t("Cancel")}
          </button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feeds view
// ---------------------------------------------------------------------------

interface FeedsViewProps {
  feeds: RssFeed[];
  isLoading: boolean;
  onOpen: (feedId: string) => void;
  onRefresh: (feedId: string) => void | Promise<void>;
  onDelete: (feedId: string) => void | Promise<void>;
  t: (k: string) => string;
}

function FeedsView({
  feeds,
  isLoading,
  onOpen,
  onRefresh,
  onDelete,
  t,
}: FeedsViewProps): ReactElement {
  if (feeds.length === 0) {
    return (
      <div style={emptyStyle}>
        {isLoading ? "Loading…" : t("No feeds yet — click + to add one.")}
      </div>
    );
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {feeds.map((feed) => (
        <li
          key={feed.id}
          style={{
            padding: "10px 12px",
            borderBottom: "1px solid var(--border)",
            cursor: "pointer",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
          onClick={() => onOpen(feed.id)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                flex: 1,
                fontWeight: 500,
                fontSize: 13,
                color: "var(--text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {feed.title || feed.url}
            </div>
            {feed.unreadCount > 0 && (
              <span
                style={{
                  background: "var(--accent)",
                  color: "var(--bg)",
                  borderRadius: 8,
                  padding: "1px 6px",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {feed.unreadCount}
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: 1, whiteSpace: "nowrap" }}>
              {feed.lastFetchedAt
                ? `${t("Last fetched")}: ${relativeTime(feed.lastFetchedAt, t("Never"))}`
                : t("Never fetched")}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void onRefresh(feed.id);
              }}
              style={iconBtnStyle}
              title={t("Refresh")}
            >
              ↻
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void onDelete(feed.id);
              }}
              style={iconBtnStyle}
              title={t("Delete feed")}
            >
              ✕
            </button>
          </div>
          {feed.lastError && (
            <div
              style={{
                fontSize: 11,
                color: "#e55",
              }}
              title={feed.lastError}
            >
              ⚠ {feed.lastError}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Articles view
// ---------------------------------------------------------------------------

interface ArticlesViewProps {
  feed: RssFeed | null;
  articles: RssArticle[];
  onOpen: (articleId: string) => void;
  onMarkAll: () => void | Promise<void>;
  t: (k: string) => string;
}

function ArticlesView({
  feed,
  articles,
  onOpen,
  onMarkAll,
  t,
}: ArticlesViewProps): ReactElement {
  if (!feed) {
    return <div style={emptyStyle}>{t("Feed not found")}</div>;
  }
  const hasUnread = articles.some((a) => a.readAt === null);
  return (
    <>
      {hasUnread && (
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          <button
            type="button"
            onClick={() => void onMarkAll()}
            style={{
              ...iconBtnStyle,
              fontSize: 12,
              padding: "4px 10px",
            }}
          >
            {t("Mark all as read")}
          </button>
        </div>
      )}
      {articles.length === 0 ? (
        <div style={emptyStyle}>{t("No articles yet")}</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {articles.map((article) => {
            const isUnread = article.readAt === null;
            const ts = article.pubDate ?? article.fetchedAt;
            return (
              <li
                key={article.id}
                style={{
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--border)",
                  cursor: "pointer",
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-start",
                }}
                onClick={() => onOpen(article.id)}
              >
                {isUnread && (
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: "var(--accent)",
                      flexShrink: 0,
                      marginTop: 5,
                    }}
                  />
                )}
                {!isUnread && <span style={{ width: 8, flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: isUnread ? 600 : 400,
                      color: "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {article.title ?? t("untitled")}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginTop: 2,
                    }}
                  >
                    {relativeTime(ts, t("Never"))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reader view
// ---------------------------------------------------------------------------

interface ReaderViewProps {
  feed: RssFeed;
  article: RssArticle | null;
  onBack: () => void;
  t: (k: string) => string;
}

function ReaderView({ feed, article, onBack, t }: ReaderViewProps): ReactElement {
  const safeHtml = useMemo(() => sanitizeRssHtml(article?.contentHtml ?? ""), [
    article?.contentHtml,
  ]);

  // Pull every <img> out of the sanitized HTML so the user can open any
  // one in the full-screen lightbox and navigate prev/next within the
  // article's gallery. DOMParser is browser-only, so this runs at render
  // time on the client.
  const images = useMemo<ImageItem[]>(
    () => (safeHtml ? extractImagesFromHtml(safeHtml) : []),
    [safeHtml],
  );
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const parseOptions = useMemo<HTMLReactParserOptions>(() => ({
    replace: (node: DOMNode) => {
      if (node.type !== "tag") return undefined;
      const el = node as Element;
      if (el.name === "a") {
        // Force every link to open in a new tab so article navigation
        // never replaces the Pi Web session in the current tab.
        return (
          <a
            href={el.attribs?.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {domToReact(el.children as DOMNode[])}
          </a>
        );
      }
      if (el.name !== "img") return undefined;
      const src = el.attribs?.src;
      if (!src) return undefined;
      const idx = images.findIndex((it) => it.src === src);
      if (idx === -1) return undefined;
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={el.attribs?.alt ?? ""}
          loading="lazy"
          style={{ cursor: "zoom-in" }}
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setLightboxIndex(idx);
          }}
        />
      );
    },
  }), [images]);

  if (!article) {
    return <div style={emptyStyle}>{t("Article not found")}</div>;
  }

  return (
    <div style={{ padding: "12px 16px", fontSize: 13, lineHeight: 1.55 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <button type="button" onClick={onBack} style={iconBtnStyle}>
          ←
        </button>
        <div style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}>
          {feed.title ?? feed.url}
        </div>
        {article.link && (
          <a
            href={article.link}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 11,
              color: "var(--accent)",
              textDecoration: "none",
            }}
          >
            {t("Open original")} ↗
          </a>
        )}
      </div>
      <h2
        style={{
          fontSize: 18,
          fontWeight: 600,
          margin: "0 0 6px",
          color: "var(--text)",
        }}
      >
        {article.title ?? t("untitled")}
      </h2>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 16 }}>
        {relativeTime(article.pubDate ?? article.fetchedAt, "")}
      </div>
      <div
        className="rss-reader-body"
        style={{ color: "var(--text)" }}
      >
        {safeHtml ? parseHtml(safeHtml, parseOptions) : null}
      </div>
      {lightboxIndex !== null && images.length > 0 && (
        <ImageLightbox
          images={images}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const iconBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--text)",
  padding: "2px 8px",
  fontSize: 14,
  lineHeight: 1.4,
  cursor: "pointer",
  flexShrink: 0,
};

const emptyStyle: React.CSSProperties = {
  padding: "32px 16px",
  textAlign: "center",
  color: "var(--text-muted)",
  fontSize: 12,
};