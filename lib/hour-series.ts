/**
 * Pure helpers for time-bucketed (hourly) series used by token-audit.
 *
 * Client-safe — no DB, no fs, no Node imports. The panel reuses these on
 * the client side to fill empty hours in the 24h chart; the server-side
 * `summarize()` uses the same parser when normalizing SQLite localtime
 * keys. Keep this file dependency-free so any side (app, client
 * component) can import from it without dragging in `better-sqlite3`.
 */

import type { HourBucket, SummaryBucket } from "./token-audit-types";

export type { HourBucket };

/**
 * Parse a SQLite localtime hour key like "2024-05-01 14:00" into epoch-ms.
 * Returns 0 if the key is malformed.
 */
export function parseLocalHourKey(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(key);
  if (!m) return 0;
  const [, y, mo, d, h, mi] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, 0, 0).getTime();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Take a raw HourBucket[] (which has gaps for empty hours) and emit a
 * fixed-length series with one entry per hour between [fromTs, toTs], filling
 * zero buckets for empty hours. Used by the 24h bar chart so the SVG has 24
 * consistent columns even when no calls landed in some hours.
 */
export function zeroPadHourSeries(
  fromTs: number,
  toTs: number,
  raw: HourBucket[],
  stepMs = 3_600_000,
): HourBucket[] {
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs < fromTs) return [];
  const byTs = new Map<number, HourBucket>();
  for (const b of raw) {
    if (b.tsMs > 0) byTs.set(b.tsMs, b);
  }
  const start = new Date(fromTs);
  start.setMinutes(0, 0, 0);
  const startMs = start.getTime();
  const out: HourBucket[] = [];
  for (let t = startMs; t <= toTs; t += stepMs) {
    const hit = byTs.get(t);
    if (hit) {
      out.push(hit);
    } else {
      const dt = new Date(t);
      const key = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
      out.push({
        key,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costTotal: 0,
        durationMs: 0,
        firstAt: 0,
        lastAt: 0,
        tsMs: t,
        avgDurationMs: 0,
      });
    }
  }
  return out;
}

/** Re-exported for callers that only need the upstream SummaryBucket shape. */
export type { SummaryBucket };
