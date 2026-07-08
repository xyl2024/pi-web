/**
 * Self-rescheduling loop for the RSS daily digest.
 *
 * Strategy mirrors `lib/rss/loop.ts` and `lib/scheduler/loop.ts`: a single
 * `setTimeout` (not `setInterval`, to avoid drift) that fires once per day
 * at the configured hour:minute in the server's local TZ.
 *
 * Each tick:
 *   1. Bail out if disabled.
 *   2. Call `runDigest(now)` which queries unread articles past the
 *      watermark, builds the digest payload, and (subject to the
 *      `minUnread` gate and the z1 "silent on zero" rule) pushes an Inbox
 *      message via `lib/inbox-store.pushMessage`.
 *   3. Advance `last_digest_at` to `now` and `next_run_at` to tomorrow's
 *      HH:MM in one DB write.
 *
 * Boot reconciliation: on `ensureDigestLoop()`, if the stored `next_run_at`
 * is in the past (server was down at trigger time), we don't fire — we just
 * recompute `next_run_at` to tomorrow's HH:MM and continue sleeping. This
 * matches the scheduler's `reconcileStaleTasks()` policy (c1 in the design):
 * "the cron expression is the source of truth, not 'catch up to wherever we
 * left off.'"
 *
 * The loop runs even when `enabled = false`: `tick()` checks `enabled` and
 * returns early. This matches the scheduler's pattern and keeps reschedule
 * semantics trivial (we never need to start/stop the loop, only edit the row).
 */

import { pushMessage } from "@/lib/inbox-store";
import { createLogger } from "@/lib/logger";
import {
  buildDigestBody,
  buildDigestPayload,
  countFeedsWithUnread,
  getSettings,
  recordTickCompletion,
  recomputeNextRunAt,
} from "@/lib/rss-digest-store";
import {
  type RssDigestSettings,
  computeNextRunAt,
} from "@/lib/rss-digest-schema";

const log = createLogger("rss-digest");

let timer: ReturnType<typeof setTimeout> | null = null;

export function isDigestLoopRunning(): boolean {
  return timer !== null;
}

/** Start the digest loop. Idempotent. */
export function ensureDigestLoop(): void {
  if (timer !== null) return;
  const settings = getSettings();
  log.info("digest loop starting", {
    enabled: settings.enabled,
    hour: settings.hour,
    minute: settings.minute,
    nextRunAt: settings.nextRunAt,
  });

  // If the stored next_run_at is already in the past, advance it without
  // firing (c1). Then re-arm.
  const now = Date.now();
  let nextRunAt = settings.nextRunAt;
  if (nextRunAt !== null && nextRunAt <= now) {
    nextRunAt = computeNextRunAt(now, settings.hour, settings.minute);
    recomputeNextRunAt(now, settings.hour, settings.minute);
    log.info("digest loop: skipped stale trigger, advanced to next future run", {
      newNextRunAt: nextRunAt,
    });
  }
  scheduleNext(nextRunAt);
}

/** Stop the digest loop. Safe to call when not running. */
export function stopDigestLoop(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
    log.info("digest loop stopped");
  }
}

/**
 * Re-arm the timer to wake at the new next_run_at. Called from the API
 * after a settings write that touched enabled/hour/minute, and from
 * `runDigest` after a successful tick.
 */
export function rescheduleDigestLoop(): void {
  if (timer === null) {
    ensureDigestLoop();
    return;
  }
  clearTimeout(timer);
  timer = null;
  const settings = getSettings();
  scheduleNext(settings.nextRunAt);
}

function scheduleNext(nextRunAt: number | null): void {
  if (timer !== null) return;
  if (nextRunAt === null) {
    log.debug("digest loop: idle (disabled or no schedule)");
    return;
  }
  const delay = Math.max(0, nextRunAt - Date.now());
  log.debug("digest loop: scheduled", { delayMs: delay, at: nextRunAt });
  timer = setTimeout(() => {
    void tick();
  }, delay);
  if (typeof timer.unref === "function") timer.unref();
}

async function tick(): Promise<void> {
  timer = null;
  let settings: RssDigestSettings;
  try {
    settings = getSettings();
  } catch (err) {
    // DB error reading settings — sleep for an hour and retry rather than
    // spinning.
    log.error("digest tick: failed to read settings", { error: String(err) });
    timer = setTimeout(() => {
      void tick();
    }, 60 * 60 * 1000);
    if (typeof timer.unref === "function") timer.unref();
    return;
  }

  if (!settings.enabled) {
    log.debug("digest tick: skipped (disabled)");
    scheduleNext(settings.nextRunAt);
    return;
  }

  await runDigest(settings, Date.now());

  // Re-read settings — the run may have updated next_run_at via
  // recordTickCompletion.
  try {
    const refreshed = getSettings();
    scheduleNext(refreshed.nextRunAt);
  } catch (err) {
    log.error("digest tick: failed to read settings post-run", { error: String(err) });
  }
}

async function runDigest(settings: RssDigestSettings, now: number): Promise<void> {
  let payload;
  try {
    payload = buildDigestPayload(settings, now);
  } catch (err) {
    log.error("digest: failed to build payload", { error: String(err) });
    // Still advance the watermark so we don't repeatedly try the same window.
    advanceWatermark(settings, now);
    return;
  }

  // Always advance the watermark on every tick (z1 + u2 + the "watermark
  // is the last run time, not the last push time" semantic).
  const nextRunAt = computeNextRunAt(now, settings.hour, settings.minute);
  recordTickCompletion({ now, nextRunAt, lastDigestAt: now });

  if (payload === null) {
    log.debug("digest: 0 unread past watermark, silent", {
      watermark: settings.lastDigestAt,
      minUnread: settings.minUnread,
    });
    return;
  }

  if (payload.totalUnread < settings.minUnread) {
    log.debug("digest: below minUnread threshold, silent", {
      totalUnread: payload.totalUnread,
      minUnread: settings.minUnread,
    });
    return;
  }

  // Body needs the unpadded feed count when we've capped.
  const totalFeedCount = countFeedsWithUnread(settings, now);
  const body = buildDigestBody(payload, totalFeedCount);
  const title = payload.totalUnread === 1
    ? "RSS daily · 1 unread"
    : `RSS daily · ${payload.totalUnread} unread`;

  // Inbox push — wrapped in try/catch so an Inbox DB hiccup never poisons
  // the digest loop. This mirrors `lib/scheduler/runner.ts:39-50` and
  // `lib/rss/loop.ts:101-117`.
  try {
    pushMessage({
      source: "rss",
      level: "info",
      title,
      payload: { body, digest: payload },
    });
    log.info("digest pushed", {
      totalUnread: payload.totalUnread,
      feedCount: payload.feeds.length,
    });
  } catch (inboxErr) {
    log.warn("inbox push failed (digest loop)", { error: String(inboxErr) });
  }
}

function advanceWatermark(settings: RssDigestSettings, now: number): void {
  const nextRunAt = computeNextRunAt(now, settings.hour, settings.minute);
  recordTickCompletion({ now, nextRunAt, lastDigestAt: now });
}

// Stop on process exit so the loop doesn't keep timers alive past shutdown.
process.once("exit", () => {
  stopDigestLoop();
});