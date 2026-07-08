/**
 * CRUD + aggregation for the RSS daily digest settings + the digest payload
 * builder. The store is the single point that talks to:
 *
 *   - `lib/rss-digest-db.ts` for the singleton settings row
 *   - `lib/rss-db.ts` for the unread-article aggregation query (joins
 *     `rss_articles` against `rss_feeds`)
 *
 * No in-memory cache; freshness is the React layer's job. The aggregation
 * function is pure (reads from the DB, returns a typed payload) so the loop
 * and the API can both call it.
 *
 * Watermark semantics (u2 in the design):
 *   - `last_digest_at` is advanced on every tick, regardless of whether a
 *     message was pushed. min_unread is a push gate, not a watermark gate.
 *   - On first enable (when `last_digest_at` is 0), the API rebases it to
 *     now() so the first digest only contains articles published after the
 *     user opted in (f1 in the design).
 */

import { getRssDigestDb } from "@/lib/rss-digest-db";
import { getRssDb } from "@/lib/rss-db";
import {
  type RssDigestArticle,
  type RssDigestFeed,
  type RssDigestPayload,
  type RssDigestSettings,
  type RssDigestSettingsPatch,
  DIGEST_BODY_MAX_CHARS,
  DIGEST_MAX_ARTICLES_PER_FEED,
  DIGEST_MAX_FEEDS,
  computeNextRunAt,
} from "@/lib/rss-digest-schema";
import { createLogger } from "@/lib/logger";

const log = createLogger("rss-digest-store");

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface SettingsRow {
  id: number;
  enabled: number;
  hour: number;
  minute: number;
  min_unread: number;
  last_digest_at: number;
  next_run_at: number | null;
  updated_at: number;
}

function rowToSettings(row: SettingsRow): RssDigestSettings {
  return {
    enabled: row.enabled === 1,
    hour: row.hour,
    minute: row.minute,
    minUnread: row.min_unread,
    lastDigestAt: row.last_digest_at,
    nextRunAt: row.next_run_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Defaults + settings CRUD
// ---------------------------------------------------------------------------

export const DIGEST_DEFAULT_HOUR = 9;
export const DIGEST_DEFAULT_MINUTE = 0;
export const DIGEST_DEFAULT_MIN_UNREAD = 1;

/** Idempotent upsert. Always leaves exactly one row (id=1) in the table. */
export function getOrCreateSettings(): RssDigestSettings {
  const db = getRssDigestDb();
  const existing = db
    .prepare(`SELECT * FROM rss_digest_settings WHERE id = 1`)
    .get() as SettingsRow | undefined;
  if (existing) return rowToSettings(existing);

  const now = Date.now();
  db.prepare(
    `INSERT INTO rss_digest_settings
       (id, enabled, hour, minute, min_unread, last_digest_at, next_run_at, updated_at)
     VALUES (1, 0, ?, ?, ?, 0, NULL, ?)`,
  ).run(DIGEST_DEFAULT_HOUR, DIGEST_DEFAULT_MINUTE, DIGEST_DEFAULT_MIN_UNREAD, now);
  const inserted = db
    .prepare(`SELECT * FROM rss_digest_settings WHERE id = 1`)
    .get() as SettingsRow;
  return rowToSettings(inserted);
}

export function getSettings(): RssDigestSettings {
  return getOrCreateSettings();
}

export interface UpdateSettingsResult {
  settings: RssDigestSettings;
  /** True when this update flipped a setting that requires loop reschedule. */
  rescheduled: boolean;
}

/**
 * Apply a patch, then recompute `next_run_at` and `last_digest_at` per the
 * design rules:
 *   - Flipping `enabled` from off → on: rebase `last_digest_at` to now() (f1)
 *     so the first digest doesn't flood the user with historical unread.
 *   - Any change to `enabled`, `hour`, or `minute`: recompute `next_run_at`
 *     (or null it out when disabling).
 *   - Pure `minUnread` change: no reschedule needed.
 */
export function updateSettings(patch: RssDigestSettingsPatch): UpdateSettingsResult {
  const current = getOrCreateSettings();
  const now = Date.now();
  const next: RssDigestSettings = {
    enabled: patch.enabled ?? current.enabled,
    hour: patch.hour ?? current.hour,
    minute: patch.minute ?? current.minute,
    minUnread: patch.minUnread ?? current.minUnread,
    lastDigestAt: current.lastDigestAt,
    nextRunAt: current.nextRunAt,
    updatedAt: now,
  };

  let rescheduled = false;
  if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
    rescheduled = true;
    if (patch.enabled) {
      // f1: first-enable rebase of the watermark.
      if (next.lastDigestAt === 0) next.lastDigestAt = now;
      next.nextRunAt = computeNextRunAt(now, next.hour, next.minute);
    } else {
      next.nextRunAt = null;
    }
  }
  if ((patch.hour !== undefined && patch.hour !== current.hour) ||
      (patch.minute !== undefined && patch.minute !== current.minute)) {
    rescheduled = true;
    if (next.enabled) {
      next.nextRunAt = computeNextRunAt(now, next.hour, next.minute);
    } else {
      next.nextRunAt = null;
    }
  }

  getRssDigestDb()
    .prepare(
      `UPDATE rss_digest_settings
          SET enabled = ?, hour = ?, minute = ?, min_unread = ?,
              last_digest_at = ?, next_run_at = ?, updated_at = ?
        WHERE id = 1`,
    )
    .run(
      next.enabled ? 1 : 0,
      next.hour,
      next.minute,
      next.minUnread,
      next.lastDigestAt,
      next.nextRunAt,
      next.updatedAt,
    );

  if (rescheduled) {
    log.info("settings updated (reschedule needed)", {
      enabled: next.enabled,
      hour: next.hour,
      minute: next.minute,
      nextRunAt: next.nextRunAt,
    });
  } else {
    log.debug("settings updated (no reschedule)", {
      minUnread: next.minUnread,
    });
  }

  return { settings: next, rescheduled };
}

/**
 * Persist a freshly-computed `next_run_at` after a tick. Called by the loop
 * right after firing (advances to tomorrow's HH:MM).
 */
export function recordTickCompletion(opts: {
  now: number;
  nextRunAt: number;
  lastDigestAt: number;
}): void {
  getRssDigestDb()
    .prepare(
      `UPDATE rss_digest_settings
          SET next_run_at = ?, last_digest_at = ?, updated_at = ?
        WHERE id = 1`,
    )
    .run(opts.nextRunAt, opts.lastDigestAt, opts.now);
}

/**
 * Persist a re-computed `next_run_at` after the loop woke up. No-op for the
 * `last_digest_at` field — that's owned by `recordTickCompletion`.
 */
export function recomputeNextRunAt(now: number, hour: number, minute: number): number {
  const nextRunAt = computeNextRunAt(now, hour, minute);
  getRssDigestDb()
    .prepare(`UPDATE rss_digest_settings SET next_run_at = ? WHERE id = 1`)
    .run(nextRunAt);
  return nextRunAt;
}

// ---------------------------------------------------------------------------
// Aggregation — pull unread articles past the watermark, group by feed
// ---------------------------------------------------------------------------

interface UnreadRow {
  feed_id: string;
  feed_title: string | null;
  title: string | null;
  link: string | null;
  pub_date: number | null;
  fetched_at: number;
}

/**
 * Build the digest payload for `settings` at time `now`. Returns `null` when
 * there's nothing unread past the watermark (z1) so the caller can skip the
 * `pushMessage` call — though the watermark still needs advancing.
 */
export function buildDigestPayload(
  settings: RssDigestSettings,
  now: number,
): RssDigestPayload | null {
  const db = getRssDb();
  const watermark = settings.lastDigestAt;
  // Pull a generous slice — top 10 feeds × 3 articles = 30, but a single
  // feed with 30 unread would still only return 30 (3 per feed). We LIMIT
  // generously so the in-memory grouping is cheap.
  const rows = db
    .prepare(
      `SELECT a.feed_id,
              f.title AS feed_title,
              a.title,
              a.link,
              a.pub_date,
              a.fetched_at
         FROM rss_articles a
         JOIN rss_feeds f ON f.id = a.feed_id
        WHERE a.read_at IS NULL
          AND COALESCE(a.pub_date, a.fetched_at) >= ?
          AND COALESCE(a.pub_date, a.fetched_at) <= ?
        ORDER BY a.feed_id ASC,
                 COALESCE(a.pub_date, a.fetched_at) DESC
        LIMIT ?`,
    )
    .all(watermark, now, DIGEST_MAX_FEEDS * DIGEST_MAX_ARTICLES_PER_FEED) as UnreadRow[];

  if (rows.length === 0) return null;

  // Group by feed_id, preserving feed insertion order (which is by
  // unread_count desc once we've capped).
  const grouped = new Map<string, UnreadRow[]>();
  for (const r of rows) {
    const arr = grouped.get(r.feed_id);
    if (arr) {
      if (arr.length < DIGEST_MAX_ARTICLES_PER_FEED) arr.push(r);
    } else {
      grouped.set(r.feed_id, [r]);
    }
  }

  // Each feed in `grouped` has up to N articles but we don't yet know the
  // total unread count per feed (we only sampled the most recent N). Run a
  // second pass to get the real count so the body text can say "foo (5)".
  const feedIds = Array.from(grouped.keys());
  const countRows = db
    .prepare(
      `SELECT feed_id, COUNT(*) AS c
         FROM rss_articles
        WHERE feed_id IN (${feedIds.map(() => "?").join(",")})
          AND read_at IS NULL
          AND COALESCE(pub_date, fetched_at) >= ?
        GROUP BY feed_id`,
    )
    .all(...feedIds, watermark) as Array<{ feed_id: string; c: number }>;
  const unreadByFeed = new Map<string, number>();
  for (const row of countRows) unreadByFeed.set(row.feed_id, row.c);

  // Sort feeds by unread count desc, take top N.
  const sortedFeedIds = feedIds
    .map((id) => ({ id, unread: unreadByFeed.get(id) ?? 0 }))
    .sort((a, b) => b.unread - a.unread)
    .slice(0, DIGEST_MAX_FEEDS)
    .map((x) => x.id);

  const feeds: RssDigestFeed[] = sortedFeedIds.map((id) => {
    const sample = grouped.get(id) ?? [];
    const articles: RssDigestArticle[] = sample
      .map((r) => ({ title: r.title ?? "", link: r.link ?? "" }))
      .filter((a) => a.link.length > 0);
    return {
      unreadCount: unreadByFeed.get(id) ?? 0,
      feedTitle: sample[0]?.feed_title ?? null,
      articles,
    };
  });

  const totalUnread = feeds.reduce((sum, f) => sum + f.unreadCount, 0);
  const feedCount = feeds.length;

  return { totalUnread, feedCount, feeds };
}

/**
 * Build the body string for a digest message: "10 of 30 feeds · foo (5),
 * bar (4), baz (3)" — capped at 200 chars with an ellipsis on truncation.
 *
 * `totalFeedCount` is the unpadded count (what `body` should reflect as the
 * "of N" denominator) when `feeds.length` was capped to `DIGEST_MAX_FEEDS`.
 */
export function buildDigestBody(
  payload: RssDigestPayload,
  totalFeedCount: number,
): string {
  const head = payload.feeds.length < totalFeedCount
    ? `${payload.feeds.length} of ${totalFeedCount} feeds`
    : payload.feeds.length === 1
      ? "1 feed"
      : `${payload.feeds.length} feeds`;

  const feedLine = payload.feeds
    .map((f) => {
      const label = f.feedTitle ?? "(untitled)";
      return `${label} (${f.unreadCount})`;
    })
    .join(", ");

  const body = `${head} · ${feedLine}`;
  if (body.length <= DIGEST_BODY_MAX_CHARS) return body;
  return body.slice(0, DIGEST_BODY_MAX_CHARS - 1) + "…";
}

/**
 * Count the feeds that have at least one unread past the watermark. Used by
 * `buildDigestBody` to decide whether to render "10 of 30 feeds" vs
 * "10 feeds".
 */
export function countFeedsWithUnread(
  settings: RssDigestSettings,
  now: number,
): number {
  const row = getRssDb()
    .prepare(
      `SELECT COUNT(DISTINCT feed_id) AS c
         FROM rss_articles
        WHERE read_at IS NULL
          AND COALESCE(pub_date, fetched_at) >= ?
          AND COALESCE(pub_date, fetched_at) <= ?`,
    )
    .get(settings.lastDigestAt, now) as { c: number };
  return row.c;
}