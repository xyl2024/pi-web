/**
 * Public types, validation helpers, and error classes for the RSS panel.
 * The data is stored in `lib/rss-store.ts` using the schema in
 * `lib/rss-db.ts`; this file is the contract between storage and the HTTP
 * routes / React layer.
 *
 * Mirror of `lib/http-collections-schema.ts`: pure data + validators, no IO.
 * Re-exported through the same surface so route handlers can `import { ... }
 * from "@/lib/rss-schema"` and have everything they need.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Global polling interval — every feed is refreshed this often. */
export const RSS_DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

/** Per-fetch size cap for RSS XML bodies (smaller than the HTTP proxy default
 *  because legitimate RSS feeds are <100KB; anything larger is suspicious). */
export const RSS_DEFAULT_SIZE_LIMIT_BYTES = 2 * 1024 * 1024;

/** Hard ceiling on a single RSS fetch — server-side proxyFetch timeout. */
export const RSS_FETCH_TIMEOUT_MS = 30_000;

export const MAX_FEED_URL_LENGTH = 2048;
export const MAX_FEED_TITLE_LENGTH = 200;

/** Upper bound on stored articles per feed — older entries get trimmed. */
export const MAX_ARTICLES_PER_FEED = 500;

// ---------------------------------------------------------------------------
// Public row shapes (consumed by the API + React layer)
// ---------------------------------------------------------------------------

export interface RssFeed {
  id: string;
  url: string;
  title: string | null;
  etag: string | null;
  lastModified: string | null;
  /** ms epoch. Null when never fetched. The loop uses this to pick the next feed. */
  lastFetchedAt: number | null;
  /** Last fetch error message, or null if the last fetch succeeded. */
  lastError: string | null;
  /** Cached count of `rss_articles.read_at IS NULL` for this feed. */
  unreadCount: number;
  createdAt: number;
}

export interface RssArticle {
  id: string;
  feedId: string;
  /** Per-feed unique key — typically <guid> for RSS 2.0 / <id> for Atom. */
  guid: string;
  title: string | null;
  link: string | null;
  /** ms epoch. Null when the feed didn't supply a pubDate. */
  pubDate: number | null;
  /** Sanitized HTML body (sanitization happens at render time, not here). */
  contentHtml: string | null;
  /** Plain-text fallback, useful for the list preview. */
  contentText: string | null;
  /** ms epoch — set every time we re-fetch this article's row. */
  fetchedAt: number;
  /** ms epoch — set when the user opens the article in the reader view. */
  readAt: number | null;
}

export interface RssListResponse {
  feeds: RssFeed[];
}

export interface RssArticlesResponse {
  articles: RssArticle[];
}

export interface CreateFeedInput {
  url: string;
  title?: string | null;
}

export interface UpdateFeedInput {
  title?: string | null;
}

/** Normalized article shape produced by parseRssXml, consumed by upsert. */
export interface ParseArticle {
  guid: string;
  title: string | null;
  link: string | null;
  pubDate: number | null;
  contentHtml: string;
  contentText: string;
}

/** Outcome of a single fetch — populated for both success and failure. */
export interface FetchResult {
  ok: boolean;
  status: number | null;
  channelTitle: string | null;
  inserted: number;
  updated: number;
  totalSeen: number;
  error: string | null;
  /** Details for articles newly inserted by this fetch — used by the per-tick
   *  Inbox push to attach links. Empty for non-insert outcomes (304, errors,
   *  re-fetches where every guid was already known). */
  insertedArticles: Array<{
    title: string | null;
    link: string | null;
    pubDate: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class RssValidationError extends Error {
  public readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "RssValidationError";
    this.field = field;
  }
}

export class RssNotFoundError extends Error {
  public readonly entityName: string;
  public readonly id: string;
  constructor(entityName: string, id: string) {
    super(`${entityName} not found: ${id}`);
    this.name = "RssNotFoundError";
    this.entityName = entityName;
    this.id = id;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validateFeedUrl(raw: unknown, field: string = "url"): string {
  if (typeof raw !== "string") {
    throw new RssValidationError(field, `${field} must be a string`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new RssValidationError(field, `${field} cannot be empty`);
  }
  if (trimmed.length > MAX_FEED_URL_LENGTH) {
    throw new RssValidationError(field, `${field} is too long`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RssValidationError(field, `${field} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RssValidationError(field, `${field} must use http(s)`);
  }
  return trimmed;
}

export function validateFeedTitle(raw: unknown, field: string = "title"): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new RssValidationError(field, `${field} must be a string`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_FEED_TITLE_LENGTH) {
    throw new RssValidationError(field, `${field} is too long`);
  }
  return trimmed;
}

export function validateReadFlag(raw: unknown, field: string = "read"): boolean {
  if (typeof raw !== "boolean") {
    throw new RssValidationError(field, `${field} must be a boolean`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateRssId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}