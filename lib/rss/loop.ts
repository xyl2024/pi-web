/**
 * Background refresh loop for the RSS panel.
 *
 * Mirrors `lib/scheduler/loop.ts` (self-rescheduling setTimeout, no
 * setInterval drift). Each tick:
 *
 *   1. Pick the N feed rows with the oldest `last_fetched_at`.
 *   2. Fetch + parse them sequentially (we want predictable DB write order
 *      and don't want to hammer upstream servers with concurrent requests).
 *   3. Wait `RSS_DEFAULT_INTERVAL_MS` and re-arm.
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
            try {
              pushMessage({
                source: "rss",
                level: "info",
                title: result.channelTitle ?? "RSS feed",
                payload: {
                  body:
                    result.inserted === 1
                      ? "1 new article"
                      : `${result.inserted} new articles`,
                },
              });
            } catch (inboxErr) {
              // Inbox is a side channel — never poison the RSS loop on push failure.
              log.warn("inbox push failed", { feedId: id, error: String(inboxErr) });
            }
          }
        } catch (err) {
          // Defensive: fetchAndRefreshFeed should never throw — it records
          // last_error on the row. Log and move on.
          log.error("rss fetch threw", { feedId: id, error: String(err) });
        }
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