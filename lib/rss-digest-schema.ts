/**
 * Public types, validation helpers, and error classes for the RSS daily digest
 * settings. Storage lives in `lib/rss-digest-store.ts` on top of
 * `lib/rss-digest-db.ts`; this file is the contract between storage, HTTP
 * routes, the React layer, and the loop.
 *
 * Mirror of `lib/rss-schema.ts`: pure data + validators, no IO. The digest
 * payload schema (`RssDigestPayload`) is also re-exported here so the Inbox
 * row renderer (`components/InboxMessageRow.tsx`) can import it from a single
 * place without dragging in the loop or store code.
 */

import type { InboxMessage } from "@/lib/inbox-schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Upper bound on the number of feeds rendered in a single digest message. */
export const DIGEST_MAX_FEEDS = 10;

/** Per-feed upper bound on the number of articles rendered. */
export const DIGEST_MAX_ARTICLES_PER_FEED = 3;

/**
 * Upper bound on the `body` string of a digest message. The Inbox spec
 * recommends ≤ 200 characters (see `docs/inbox.md` §2) — we keep that
 * budget tight so the body never crowds out the digest payload.
 */
export const DIGEST_BODY_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// Settings row shape (singleton, id PK = 1)
// ---------------------------------------------------------------------------

/** Wire shape returned by the API + consumed by the React layer. */
export interface RssDigestSettings {
  enabled: boolean;
  /** 0–23, local TZ. */
  hour: number;
  /** 0–59, local TZ. */
  minute: number;
  /** Minimum total unread across all feeds required to push a message. */
  minUnread: number;
  /** Epoch ms. 0 until the digest has fired at least once. */
  lastDigestAt: number;
  /** Epoch ms. Null when disabled or not yet computed. */
  nextRunAt: number | null;
  /** Epoch ms. */
  updatedAt: number;
}

/** Patch accepted by PUT /api/rss/digest-settings. Every field optional. */
export interface RssDigestSettingsPatch {
  enabled?: boolean;
  hour?: number;
  minute?: number;
  minUnread?: number;
}

// ---------------------------------------------------------------------------
// Digest payload (the `payload.digest` field on a pushed InboxMessage)
// ---------------------------------------------------------------------------

export interface RssDigestArticle {
  title: string;
  link: string;
}

export interface RssDigestFeed {
  /** Per-feed unread count at aggregation time. */
  unreadCount: number;
  /** Best-effort: the feed's stored title or null. */
  feedTitle: string | null;
  /** Capped to `DIGEST_MAX_ARTICLES_PER_FEED` newest by `pub_date`/`fetched_at`. */
  articles: RssDigestArticle[];
}

export interface RssDigestPayload {
  /** Total unread across all feeds that had ≥1 unread after the watermark. */
  totalUnread: number;
  /** Number of feeds with ≥1 unread. May exceed `feeds.length` if capped. */
  feedCount: number;
  /** Capped to top `DIGEST_MAX_FEEDS` by `unreadCount` desc. */
  feeds: RssDigestFeed[];
}

// ---------------------------------------------------------------------------
// Inbox message shape (the actual pushed InboxMessage)
// ---------------------------------------------------------------------------

/**
 * The pushed InboxMessage for the daily digest. The library never types the
 * loop output — this is here for documentation and for any future caller
 * that wants to construct one by hand.
 */
export type RssDigestInboxMessage = InboxMessage & {
  source: "rss";
  payload: { body: string; digest: RssDigestPayload };
};

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class RssDigestValidationError extends Error {
  public readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "RssDigestValidationError";
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validateEnabled(raw: unknown, field: string = "enabled"): boolean {
  if (typeof raw !== "boolean") {
    throw new RssDigestValidationError(field, `${field} must be a boolean`);
  }
  return raw;
}

export function validateHour(raw: unknown, field: string = "hour"): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new RssDigestValidationError(field, `${field} must be an integer`);
  }
  if (raw < 0 || raw > 23) {
    throw new RssDigestValidationError(field, `${field} must be between 0 and 23`);
  }
  return raw;
}

export function validateMinute(raw: unknown, field: string = "minute"): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new RssDigestValidationError(field, `${field} must be an integer`);
  }
  if (raw < 0 || raw > 59) {
    throw new RssDigestValidationError(field, `${field} must be between 0 and 59`);
  }
  return raw;
}

export function validateMinUnread(raw: unknown, field: string = "minUnread"): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new RssDigestValidationError(field, `${field} must be an integer`);
  }
  if (raw < 1) {
    throw new RssDigestValidationError(field, `${field} must be at least 1`);
  }
  return raw;
}

export function validatePatch(raw: unknown): RssDigestSettingsPatch {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RssDigestValidationError("payload", "payload must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const patch: RssDigestSettingsPatch = {};
  if ("enabled" in obj) patch.enabled = validateEnabled(obj.enabled);
  if ("hour" in obj) patch.hour = validateHour(obj.hour);
  if ("minute" in obj) patch.minute = validateMinute(obj.minute);
  if ("minUnread" in obj) patch.minUnread = validateMinUnread(obj.minUnread);
  return patch;
}

// ---------------------------------------------------------------------------
// Time computation
// ---------------------------------------------------------------------------

/**
 * Compute the next epoch-ms timestamp that matches the configured hour:minute
 * in the server's local TZ. If `now` is already past today's HH:MM, returns
 * tomorrow's HH:MM.
 */
export function computeNextRunAt(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  const candidate = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    hour,
    minute,
    0,
    0,
  );
  if (candidate.getTime() <= now) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}