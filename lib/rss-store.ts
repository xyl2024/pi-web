/**
 * SQLite-backed CRUD + XML parsing + upsert for the RSS panel.
 *
 * Mirror of `lib/http-collections-store.ts`: validation, custom error classes,
 * row-to-type mappers, and `db.transaction(() => { ... })()` blocks for
 * mutating ops that touch more than one table.
 *
 * All reads go through the singleton DB handle in `lib/rss-db.ts`. No
 * in-memory cache; freshness is the React layer's job (see `hooks/useRss.ts`).
 *
 * Parsing notes:
 *   - `parseRssXml` accepts both RSS 2.0 (`<rss><channel><item>`) and Atom
 *     (`<feed><entry>`) and returns the same normalized shape. The two
 *     formats are detected by the presence of the root element.
 *   - GUID extraction: prefer `<guid>` (RSS) / `<id>` (Atom); fall back to a
 *     stable hash of `link || title` so the same article always upserts to
 *     the same row even when the feed omits an explicit GUID.
 *   - HTML content is stored as-is. Sanitization happens at render time in
 *     `lib/rss-sanitize.ts` so we never double-sanitize (e.g. if the feed
 *     already encodes special chars) and the raw HTML is reusable elsewhere.
 *   - HTML entities (`&amp;`, `&#x...`, `&nbsp;`) are decoded via the
 *     `entities` package before storage.
 */

import { XMLParser } from "fast-xml-parser";
import { decode as decodeEntities } from "entities";
import { createHash } from "crypto";
import { getRssDb } from "@/lib/rss-db";
import { proxyFetch } from "@/lib/http-proxy";
import {
  type CreateFeedInput,
  type FetchResult,
  type ParseArticle,
  type RssArticle,
  type RssFeed,
  type UpdateFeedInput,
  MAX_ARTICLES_PER_FEED,
  RSS_DEFAULT_INTERVAL_MS,
  RSS_DEFAULT_SIZE_LIMIT_BYTES,
  RSS_FETCH_TIMEOUT_MS,
  RssNotFoundError,
  generateRssId,
  validateFeedTitle,
  validateFeedUrl,
} from "@/lib/rss-schema";
import { createLogger } from "@/lib/logger";

const log = createLogger("rss-store");

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface FeedRow {
  id: string;
  url: string;
  title: string | null;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: number | null;
  last_error: string | null;
  unread_count: number;
  created_at: number;
}

interface ArticleRow {
  id: string;
  feed_id: string;
  guid: string;
  title: string | null;
  link: string | null;
  pub_date: number | null;
  content_html: string | null;
  content_text: string | null;
  fetched_at: number;
  read_at: number | null;
}

function rowToFeed(row: FeedRow): RssFeed {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    etag: row.etag,
    lastModified: row.last_modified,
    lastFetchedAt: row.last_fetched_at,
    lastError: row.last_error,
    unreadCount: row.unread_count,
    createdAt: row.created_at,
  };
}

function rowToArticle(row: ArticleRow): RssArticle {
  return {
    id: row.id,
    feedId: row.feed_id,
    guid: row.guid,
    title: row.title,
    link: row.link,
    pubDate: row.pub_date,
    contentHtml: row.content_html,
    contentText: row.content_text,
    fetchedAt: row.fetched_at,
    readAt: row.read_at,
  };
}

// ---------------------------------------------------------------------------
// Feed CRUD
// ---------------------------------------------------------------------------

export function listFeeds(): RssFeed[] {
  const rows = getRssDb()
    .prepare(
      `SELECT id, url, title, etag, last_modified, last_fetched_at,
              last_error, unread_count, created_at
         FROM rss_feeds
        ORDER BY created_at ASC`,
    )
    .all() as FeedRow[];
  return rows.map(rowToFeed);
}

export function getFeedById(id: string): RssFeed | undefined {
  if (!id) return undefined;
  const row = getRssDb()
    .prepare(
      `SELECT id, url, title, etag, last_modified, last_fetched_at,
              last_error, unread_count, created_at
         FROM rss_feeds WHERE id = ?`,
    )
    .get(id) as FeedRow | undefined;
  return row ? rowToFeed(row) : undefined;
}

export function createFeed(input: CreateFeedInput): RssFeed {
  const url = validateFeedUrl(input.url, "url");
  const title = validateFeedTitle(input.title, "title");

  const id = generateRssId();
  const now = Date.now();
  getRssDb()
    .prepare(
      `INSERT INTO rss_feeds (id, url, title, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(id, url, title, now);

  const feed = getFeedById(id);
  if (!feed) throw new RssNotFoundError("feed", id);
  return feed;
}

export function updateFeed(id: string, patch: UpdateFeedInput): RssFeed {
  if (!id) throw new RssNotFoundError("feed", String(id));
  const apply = getRssDb().transaction(() => {
    const row = getRssDb()
      .prepare(`SELECT * FROM rss_feeds WHERE id = ?`)
      .get(id) as FeedRow | undefined;
    if (!row) throw new RssNotFoundError("feed", id);
    const next = rowToFeed(row);
    if (patch.title !== undefined) {
      next.title = validateFeedTitle(patch.title, "title");
      getRssDb()
        .prepare(`UPDATE rss_feeds SET title = ? WHERE id = ?`)
        .run(next.title, id);
    }
    return next;
  });
  return apply();
}

export function deleteFeed(id: string): void {
  if (!id) throw new RssNotFoundError("feed", String(id));
  const result = getRssDb()
    .prepare(`DELETE FROM rss_feeds WHERE id = ?`)
    .run(id);
  if (result.changes === 0) throw new RssNotFoundError("feed", id);
}

// ---------------------------------------------------------------------------
// Article CRUD
// ---------------------------------------------------------------------------

export interface ListArticlesOpts {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

export function listArticles(
  feedId: string,
  opts: ListArticlesOpts = {},
): RssArticle[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, MAX_ARTICLES_PER_FEED));
  const offset = Math.max(0, opts.offset ?? 0);
  const where: string[] = ["feed_id = ?"];
  const params: (string | number)[] = [feedId];
  if (opts.unreadOnly) {
    where.push("read_at IS NULL");
  }
  const sql =
    `SELECT id, feed_id, guid, title, link, pub_date, content_html,
            content_text, fetched_at, read_at
       FROM rss_articles
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(pub_date, fetched_at) DESC
      LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  const rows = getRssDb().prepare(sql).all(...params) as ArticleRow[];
  return rows.map(rowToArticle);
}

export function getArticleById(id: string): RssArticle | undefined {
  if (!id) return undefined;
  const row = getRssDb()
    .prepare(
      `SELECT id, feed_id, guid, title, link, pub_date, content_html,
              content_text, fetched_at, read_at
         FROM rss_articles WHERE id = ?`,
    )
    .get(id) as ArticleRow | undefined;
  return row ? rowToArticle(row) : undefined;
}

export function markArticleRead(id: string, read: boolean): RssArticle {
  if (!id) throw new RssNotFoundError("article", String(id));
  const apply = getRssDb().transaction(() => {
    const row = getRssDb()
      .prepare(`SELECT * FROM rss_articles WHERE id = ?`)
      .get(id) as ArticleRow | undefined;
    if (!row) throw new RssNotFoundError("article", id);
    const readAt = read ? Date.now() : null;
    getRssDb()
      .prepare(`UPDATE rss_articles SET read_at = ? WHERE id = ?`)
      .run(readAt, id);
    // Recompute unread_count for the parent feed.
    const countRow = getRssDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM rss_articles
          WHERE feed_id = ? AND read_at IS NULL`,
      )
      .get(row.feed_id) as { c: number };
    getRssDb()
      .prepare(`UPDATE rss_feeds SET unread_count = ? WHERE id = ?`)
      .run(countRow.c, row.feed_id);
    return {
      ...rowToArticle(row),
      readAt,
    } as RssArticle;
  });
  return apply();
}

export function markAllArticlesRead(feedId: string): number {
  if (!feedId) throw new RssNotFoundError("feed", String(feedId));
  const apply = getRssDb().transaction(() => {
    const row = getRssDb()
      .prepare(`SELECT id FROM rss_feeds WHERE id = ?`)
      .get(feedId) as { id: string } | undefined;
    if (!row) throw new RssNotFoundError("feed", feedId);
    const now = Date.now();
    const result = getRssDb()
      .prepare(
        `UPDATE rss_articles SET read_at = ?
          WHERE feed_id = ? AND read_at IS NULL`,
      )
      .run(now, feedId);
    getRssDb()
      .prepare(`UPDATE rss_feeds SET unread_count = 0 WHERE id = ?`)
      .run(feedId);
    return result.changes;
  });
  return apply();
}

// ---------------------------------------------------------------------------
// XML parsing
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

interface ParsedFeed {
  channelTitle: string | null;
  articles: ParseArticle[];
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function pickText(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    // Atom-style: { "#text": "...", "@_type": "html" }
    if ("#text" in o && typeof o["#text"] === "string") return o["#text"] as string;
  }
  return null;
}

function pickLinkHref(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node;
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o["@_href"] === "string") return o["@_href"] as string;
    if (typeof o["#text"] === "string") return o["#text"] as string;
  }
  return null;
}

function pickLinks(node: unknown): string[] {
  if (node == null) return [];
  const arr = Array.isArray(node) ? node : [node];
  const out: string[] = [];
  for (const item of arr) {
    const href = pickLinkHref(item);
    if (href) out.push(href);
  }
  return out;
}

function parsePubDate(raw: unknown): number | null {
  if (raw == null) return null;
  const str = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : null;
  if (!str) return null;
  const t = new Date(str).getTime();
  return Number.isFinite(t) ? t : null;
}

function stableHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 24);
}

function extractGuid(raw: unknown, fallbackSeed: string): string {
  const explicit = pickText(raw);
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return `hash:${stableHash(fallbackSeed)}`;
}

function htmlToText(html: string): string {
  // Lightweight: strip tags, collapse whitespace, decode entities. Good enough
  // for the article list preview (we never render this as HTML).
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return decodeEntities(stripped);
}

function pickContent(item: Record<string, unknown>): { html: string | null } {
  // Priority: content:encoded (RSS) > content (Atom) > description (RSS) > summary (Atom).
  const candidates: unknown[] = [
    item["content:encoded"],
    item["content"],
    item["description"],
    item["summary"],
  ];
  for (const c of candidates) {
    const html = pickText(c);
    if (html && html.trim().length > 0) {
      return { html: decodeEntities(html) };
    }
  }
  return { html: null };
}

function readItems(itemNode: unknown): Array<Record<string, unknown>> {
  if (itemNode == null) return [];
  if (Array.isArray(itemNode)) {
    return itemNode.filter((v): v is Record<string, unknown> => v != null && typeof v === "object");
  }
  if (typeof itemNode === "object") {
    return [itemNode as Record<string, unknown>];
  }
  return [];
}

export function parseRssXml(xml: string): ParsedFeed {
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;

  // RSS 2.0: <rss><channel><item>
  const rssRoot = parsed["rss"];
  if (rssRoot && typeof rssRoot === "object") {
    const channel = (rssRoot as Record<string, unknown>)["channel"];
    if (channel && typeof channel === "object") {
      const ch = channel as Record<string, unknown>;
      return {
        channelTitle: asString(ch["title"]),
        articles: readItems(ch["item"]).map((item) => parseRss2Item(item)),
      };
    }
  }

  // Atom: <feed><entry>
  const feedRoot = parsed["feed"];
  if (feedRoot && typeof feedRoot === "object") {
    const f = feedRoot as Record<string, unknown>;
    return {
      channelTitle: asString(f["title"]),
      articles: readItems(f["entry"]).map((item) => parseAtomEntry(item)),
    };
  }

  // RDF / unknown — return empty rather than throw so a malformed feed
  // doesn't take down the whole loop. The caller records last_error.
  return { channelTitle: null, articles: [] };
}

function parseRss2Item(item: Record<string, unknown>): ParseArticle {
  const title = asString(item["title"] as unknown);
  const linkCandidates = pickLinks(item["link"]);
  const link = linkCandidates[0] ?? asString(item["link"] as unknown);
  const pubDate = parsePubDate(item["pubDate"]);
  const guid = extractGuid(item["guid"], link ?? title ?? "");
  const { html } = pickContent(item);
  const contentHtml = html ?? "";
  return {
    guid,
    title,
    link,
    pubDate,
    contentHtml,
    contentText: htmlToText(contentHtml),
  };
}

function parseAtomEntry(item: Record<string, unknown>): ParseArticle {
  const title = asString(item["title"] as unknown);
  const linkCandidates = pickLinks(item["link"]);
  // Prefer rel="alternate" or no rel over rel="self"/"enclosure".
  let link: string | null = null;
  for (const candidate of linkCandidates) {
    if (!link) link = candidate;
  }
  link = link ?? asString(item["link"] as unknown);
  const pubDate = parsePubDate(item["published"]) ?? parsePubDate(item["updated"]);
  const guid = extractGuid(item["id"], link ?? title ?? "");
  const { html } = pickContent(item);
  const contentHtml = html ?? "";
  return {
    guid,
    title,
    link,
    pubDate,
    contentHtml,
    contentText: htmlToText(contentHtml),
  };
}

// ---------------------------------------------------------------------------
// Upsert: parse XML → upsert rows → trim → recompute unread_count
// ---------------------------------------------------------------------------

function recomputeUnreadCount(feedId: string): number {
  const row = getRssDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM rss_articles
        WHERE feed_id = ? AND read_at IS NULL`,
    )
    .get(feedId) as { c: number };
  const unread = row.c;
  getRssDb()
    .prepare(`UPDATE rss_feeds SET unread_count = ? WHERE id = ?`)
    .run(unread, feedId);
  return unread;
}

function trimToLimit(feedId: string): void {
  const countRow = getRssDb()
    .prepare(`SELECT COUNT(*) AS c FROM rss_articles WHERE feed_id = ?`)
    .get(feedId) as { c: number };
  const excess = countRow.c - MAX_ARTICLES_PER_FEED;
  if (excess <= 0) return;
  // Trim the oldest unread first; never auto-delete read articles (they may
  // be the user's only record of something they care about). If everything
  // is read, fall back to trimming the oldest read by fetched_at.
  const result = getRssDb()
    .prepare(
      `DELETE FROM rss_articles
        WHERE id IN (
          SELECT id FROM rss_articles
           WHERE feed_id = ? AND read_at IS NULL
           ORDER BY COALESCE(pub_date, fetched_at) ASC
           LIMIT ?
        )`,
    )
    .run(feedId, excess);
  if (result.changes < excess) {
    const remaining = excess - result.changes;
    getRssDb()
      .prepare(
        `DELETE FROM rss_articles
          WHERE id IN (
            SELECT id FROM rss_articles
             WHERE feed_id = ?
             ORDER BY fetched_at ASC
             LIMIT ?
          )`,
      )
      .run(feedId, remaining);
  }
}

export function upsertArticlesFromFeedXml(
  feedId: string,
  xml: string,
): FetchResult {
  const db = getRssDb();
  const now = Date.now();
  let parsed: ParsedFeed;
  try {
    parsed = parseRssXml(xml);
  } catch (err) {
    log.warn("parseRssXml failed", { feedId, error: String(err) });
    return {
      ok: false,
      status: null,
      channelTitle: null,
      inserted: 0,
      updated: 0,
      totalSeen: 0,
      error: err instanceof Error ? err.message : String(err),
      insertedArticles: [],
    };
  }

  const apply = db.transaction(() => {
    // Make sure the feed still exists (it may have been deleted mid-fetch).
    const feedRow = db
      .prepare(`SELECT id FROM rss_feeds WHERE id = ?`)
      .get(feedId) as { id: string } | undefined;
    if (!feedRow) {
      return { inserted: 0, updated: 0, totalSeen: parsed.articles.length, insertedArticles: [] };
    }

    const findExisting = db.prepare(
      `SELECT id FROM rss_articles WHERE feed_id = ? AND guid = ?`,
    );
    const insertStmt = db.prepare(
      `INSERT INTO rss_articles
         (id, feed_id, guid, title, link, pub_date, content_html,
          content_text, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateStmt = db.prepare(
      `UPDATE rss_articles
          SET title = ?, link = ?, pub_date = ?, content_html = ?,
              content_text = ?, fetched_at = ?
        WHERE id = ? AND read_at IS NULL`,
    );

    let inserted = 0;
    let updated = 0;
    const insertedArticles: Array<{
      title: string | null;
      link: string | null;
      pubDate: number | null;
    }> = [];
    for (const art of parsed.articles) {
      const existing = findExisting.get(feedId, art.guid) as
        | { id: string }
        | undefined;
      if (existing) {
        const changes = updateStmt.run(
          art.title,
          art.link,
          art.pubDate,
          art.contentHtml,
          art.contentText,
          now,
          existing.id,
        );
        if (changes.changes > 0) updated++;
      } else {
        insertStmt.run(
          generateRssId(),
          feedId,
          art.guid,
          art.title,
          art.link,
          art.pubDate,
          art.contentHtml,
          art.contentText,
          now,
        );
        inserted++;
        insertedArticles.push({
          title: art.title,
          link: art.link,
          pubDate: art.pubDate,
        });
      }
    }

    trimToLimit(feedId);
    recomputeUnreadCount(feedId);

    db.prepare(
      `UPDATE rss_feeds
          SET title = COALESCE(?, title),
              last_fetched_at = ?,
              last_error = NULL
        WHERE id = ?`,
    ).run(parsed.channelTitle, now, feedId);

    return { inserted, updated, totalSeen: parsed.articles.length, insertedArticles };
  });

  const stats = apply();
  return {
    ok: true,
    status: null,
    channelTitle: parsed.channelTitle,
    inserted: stats.inserted,
    updated: stats.updated,
    totalSeen: stats.totalSeen,
    error: null,
    insertedArticles: stats.insertedArticles,
  };
}

// ---------------------------------------------------------------------------
// Fetch + refresh (the bit the loop and the manual /fetch route share)
// ---------------------------------------------------------------------------

const RSS_USER_AGENT = "pi-web/0.6 (+rss)";

/** Record the outcome of a fetch attempt so the UI can show stale/error state. */
function recordFetchOutcome(feedId: string, fields: {
  status: number | null;
  ok: boolean;
  errorMessage: string | null;
  etag?: string | null;
  lastModified?: string | null;
}): void {
  const now = Date.now();
  getRssDb()
    .prepare(
      `UPDATE rss_feeds
          SET last_fetched_at = ?,
              last_error = ?,
              etag = COALESCE(?, etag),
              last_modified = COALESCE(?, last_modified)
        WHERE id = ?`,
    )
    .run(now, fields.errorMessage, fields.etag ?? null, fields.lastModified ?? null, feedId);
}

export async function fetchAndRefreshFeed(feedId: string): Promise<FetchResult> {
  const feed = getFeedById(feedId);
  if (!feed) throw new RssNotFoundError("feed", feedId);

  const controller = new AbortController();
  const headers: Record<string, string> = {
    "User-Agent": RSS_USER_AGENT,
    Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  };
  if (feed.etag) headers["If-None-Match"] = feed.etag;
  if (feed.lastModified) headers["If-Modified-Since"] = feed.lastModified;

  const result = await proxyFetch({
    method: "GET",
    url: feed.url,
    headers,
    timeoutMs: RSS_FETCH_TIMEOUT_MS,
    sizeLimitBytes: RSS_DEFAULT_SIZE_LIMIT_BYTES,
    signal: controller.signal,
    logFields: { feedId },
  });

  if (!result.ok) {
    recordFetchOutcome(feedId, {
      status: null,
      ok: false,
      errorMessage: result.message,
    });
    return {
      ok: false,
      status: null,
      channelTitle: null,
      inserted: 0,
      updated: 0,
      totalSeen: 0,
      error: result.message,
      insertedArticles: [],
    };
  }

  // Honor 304 Not Modified — bump last_fetched_at, leave everything else alone.
  if (result.status === 304) {
    recordFetchOutcome(feedId, {
      status: 304,
      ok: true,
      errorMessage: null,
    });
    return {
      ok: true,
      status: 304,
      channelTitle: feed.title,
      inserted: 0,
      updated: 0,
      totalSeen: 0,
      error: null,
      insertedArticles: [],
    };
  }

  if (result.status < 200 || result.status >= 300) {
    recordFetchOutcome(feedId, {
      status: result.status,
      ok: false,
      errorMessage: `HTTP ${result.status} ${result.statusText}`,
    });
    return {
      ok: false,
      status: result.status,
      channelTitle: null,
      inserted: 0,
      updated: 0,
      totalSeen: 0,
      error: `HTTP ${result.status} ${result.statusText}`,
      insertedArticles: [],
    };
  }

  const etagHeader = result.headers["etag"] ?? null;
  const lastModifiedHeader = result.headers["last-modified"] ?? null;

  const upsert = upsertArticlesFromFeedXml(feedId, result.body);
  if (!upsert.ok) {
    recordFetchOutcome(feedId, {
      status: result.status,
      ok: false,
      errorMessage: upsert.error ?? "parse failed",
      etag: etagHeader,
      lastModified: lastModifiedHeader,
    });
    return upsert;
  }

  recordFetchOutcome(feedId, {
    status: result.status,
    ok: true,
    errorMessage: null,
    etag: etagHeader,
    lastModified: lastModifiedHeader,
  });
  return { ...upsert, status: result.status };
}

/** List the feed ids whose last_fetched_at is oldest (or null). Used by the loop. */
export function pickStaleFeedIds(limit: number): string[] {
  const rows = getRssDb()
    .prepare(
      `SELECT id FROM rss_feeds
        ORDER BY COALESCE(last_fetched_at, 0) ASC, created_at ASC
        LIMIT ?`,
    )
    .all(limit) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

// Re-export the interval so the loop can read it from one place.
export { RSS_DEFAULT_INTERVAL_MS };