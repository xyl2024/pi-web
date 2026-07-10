/**
 * Background refresh loop for the RSS panel.
 *
 * Mirrors `lib/scheduler/loop.ts` (self-rescheduling setTimeout, no
 * setInterval drift). Each tick:
 *
 *   1. Pick the N feed rows with the oldest `last_fetched_at`.
 *   2. Fetch + parse them sequentially (we want predictable DB write order
 *      and don't want to hammer upstream servers with concurrent requests).
 *   3. If any feed produced new articles, push ONE Inbox message per tick
 *      containing a structured list of every new article (title + link),
 *      grouped by feed. Articles are deduplicated by guid at the DB layer
 *      so re-fetches never re-push the same row.
 *   4. Wait `RSS_DEFAULT_INTERVAL_MS` and re-arm.
 *
 * Unlike the scheduler, there's no cron expression — RSS_DEFAULT_INTERVAL_MS
 * is a single global constant. Failed feeds stay in the queue and get retried
 * on the next tick; we deliberately don't implement backoff so a flapping
 * feed can recover as soon as it comes back.
 *
 * API routes can call `reschedule()` after CRUD, but for RSS it's a no-op
 * once the loop is running (the new feed will be picked up on the next tick
 * anyway, and tick cadence is short relative to feed lifetimes).
 */

import {
  fetchAndRefreshFeed,
  pickStaleFeedIds,
  RSS_DEFAULT_INTERVAL_MS,
} from "@/lib/rss-store";
import { pushMessage } from "@/lib/inbox-store";
import { createLogger } from "@/lib/logger";

const log = createLogger("rss/loop");

/** How many feeds to refresh per tick. Keeps tick latency predictable. */
const FEEDS_PER_TICK = 10;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

export function isLoopRunning(): boolean {
  return timer !== null;
}

/** Start the refresh loop. Idempotent. */
export function ensureLoop(): void {
  if (timer !== null) return;
  log.info("rss loop starting", {
    intervalMs: RSS_DEFAULT_INTERVAL_MS,
    feedsPerTick: FEEDS_PER_TICK,
  });
  // First tick is deferred so we don't block the instrumentation bootstrap
  // on a chain of upstream fetches.
  timer = setTimeout(() => {
    void tick();
  }, 0);
  if (typeof timer.unref === "function") timer.unref();
}

/** Stop the refresh loop. Safe to call when not running. */
export function stopLoop(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
    log.info("rss loop stopped");
  }
}

/** Force a fresh tick on the next loop. No-op when not running. */
export function reschedule(): void {
  if (timer === null) {
    ensureLoop();
    return;
  }
  clearTimeout(timer);
  timer = null;
  timer = setTimeout(() => {
    void tick();
  }, 0);
  if (typeof timer.unref === "function") timer.unref();
}

async function tick(): Promise<void> {
  timer = null;
  if (running) {
    // Re-arm immediately if a previous tick somehow overlapped (shouldn't
    // happen — tick is sync-sequential — but guards against future refactors).
    scheduleNext(RSS_DEFAULT_INTERVAL_MS);
    return;
  }
  running = true;
  try {
    const ids = pickStaleFeedIds(FEEDS_PER_TICK);
    const newFeedGroups: Array<{
      feedTitle: string | null;
      unreadCount: number;
      articles: Array<{ title: string; link: string }>;
    }> = [];

    if (ids.length > 0) {
      log.info("rss tick: refreshing", { count: ids.length });
      for (const id of ids) {
        try {
          const result = await fetchAndRefreshFeed(id);
          if (!result.ok) {
            log.warn("rss fetch failed", { feedId: id, error: result.error });
            continue;
          }
          if (result.inserted > 0) {
            // Drop articles with no link — InboxMessageRow renders each as an
            // <a> tag, so a missing link would render an empty href.
            const articles = result.insertedArticles
              .filter((a): a is { title: string | null; link: string; pubDate: number | null } =>
                typeof a.link === "string" && a.link.length > 0,
              )
              .map((a) => ({ title: a.title ?? "", link: a.link }));
            newFeedGroups.push({
              feedTitle: result.channelTitle,
              unreadCount: result.inserted,
              articles,
            });
          }
        } catch (err) {
          // Defensive: fetchAndRefreshFeed should never throw — it records
          // last_error on the row. Log and move on.
          log.error("rss fetch threw", { feedId: id, error: String(err) });
        }
      }
    }

    // One consolidated Inbox push per tick (matches user's "仅推送一次" rule).
    // Skipped silently when the tick produced nothing new — no empty messages.
    if (newFeedGroups.length > 0) {
      const totalNew = newFeedGroups.reduce((sum, g) => sum + g.unreadCount, 0);
      try {
        pushMessage({
          source: "rss",
          level: "info",
          title: "RSS updates",
          payload: {
            body: totalNew === 1 ? "1 new article" : `${totalNew} new articles`,
            articles: {
              totalNew,
              feedCount: newFeedGroups.length,
              feeds: newFeedGroups,
            },
          },
        });
      } catch (inboxErr) {
        // Inbox is a side channel — never poison the RSS loop on push failure.
        log.warn("inbox push failed", { error: String(inboxErr) });
      }
    }
  } finally {
    running = false;
    scheduleNext(RSS_DEFAULT_INTERVAL_MS);
  }
}

function scheduleNext(delayMs: number): void {
  if (timer !== null) return;
  const ms = Math.max(0, Math.floor(delayMs));
  timer = setTimeout(() => {
    void tick();
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
}

// Stop on process exit so the loop doesn't keep timers alive past shutdown.
process.once("exit", () => {
  stopLoop();
});