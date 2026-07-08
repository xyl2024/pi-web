/**
 * Smoke test for `lib/rss-digest-store.ts`. Runs CRUD + aggregation against a
 * temp DB (PI_WEB_RSS_DIGEST_DB env var override + a separate temp RSS DB),
 * prints results, exits.
 *
 * Mirrors `scripts/test-http-collections-store.ts` and `scripts/test-inbox-test-endpoint.ts`:
 *   - Override DB paths BEFORE importing store modules so the singletons land
 *     on the temp files.
 *   - Insert RSS feeds/articles directly via better-sqlite3 (the store has no
 *     public helper for synthetic inserts).
 *
 * Usage:  npx tsx scripts/test-rss-digest-store.ts
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Override DB paths BEFORE importing anything that calls getRssDigestDb / getRssDb.
const tmpDir = mkdtempSync(join(tmpdir(), "rss-digest-test-"));
process.env.PI_WEB_RSS_DIGEST_DB = join(tmpDir, "digest.db");
process.env.PI_WEB_RSS_DB = join(tmpDir, "rss.db");

import Database from "better-sqlite3";

// referenced below via better-sqlite3's types; kept for clarity even though
// the test only uses the helpers that internally instantiate it.
void Database;

import {
  buildDigestBody,
  buildDigestPayload,
  countFeedsWithUnread,
  getOrCreateSettings,
  recordTickCompletion,
  updateSettings,
} from "@/lib/rss-digest-store";
import {
  DIGEST_MAX_ARTICLES_PER_FEED,
  DIGEST_MAX_FEEDS,
  RssDigestValidationError,
  computeNextRunAt,
  validatePatch,
} from "@/lib/rss-digest-schema";
import { getRssDb } from "@/lib/rss-db";
import { getRssDigestDb } from "@/lib/rss-digest-db";

function log(label: string, value: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup() {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function insertFeed(id: string, title: string): void {
  getRssDb()
    .prepare(
      `INSERT INTO rss_feeds (id, url, title, created_at, unread_count)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run(id, `https://example.com/${id}.xml`, title, Date.now());
}

function insertArticle(opts: {
  feedId: string;
  guid: string;
  title: string;
  link: string;
  pubDate: number;
  readAt?: number | null;
}): void {
  getRssDb()
    .prepare(
      `INSERT INTO rss_articles
         (id, feed_id, guid, title, link, pub_date, content_html, content_text, fetched_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?)`,
    )
    .run(
      opts.guid,
      opts.feedId,
      opts.guid,
      opts.title,
      opts.link,
      opts.pubDate,
      opts.pubDate,
      opts.readAt ?? null,
    );
}

(async () => {
  try {
    // 1) defaults: getOrCreateSettings on a fresh DB returns the canonical defaults
    const initial = getOrCreateSettings();
    log("defaults", initial);
    assert(initial.enabled === false, "default enabled is false");
    assert(initial.hour === 9, "default hour 9");
    assert(initial.minute === 0, "default minute 0");
    assert(initial.minUnread === 1, "default minUnread 1");
    assert(initial.lastDigestAt === 0, "default lastDigestAt 0");
    assert(initial.nextRunAt === null, "default nextRunAt null");

    // 2) updateSettings: enable + first-time rebase of lastDigestAt
    // Patch next_run_at manually so we can compute relative deltas.
    getRssDigestDb()
      .prepare(`UPDATE rss_digest_settings SET last_digest_at = 0, next_run_at = NULL WHERE id = 1`)
      .run();

    const enableResult = updateSettings({
      enabled: true,
      hour: 9,
      minute: 0,
      minUnread: 1,
    });
    log("after enable", enableResult.settings);
    assert(enableResult.settings.enabled === true, "now enabled");
    assert(enableResult.settings.lastDigestAt > 0, "f1: lastDigestAt rebased to now");
    assert(
      enableResult.settings.nextRunAt !== null &&
        enableResult.settings.nextRunAt > Date.now() - 1000,
      "nextRunAt computed",
    );
    assert(enableResult.rescheduled === true, "rescheduled flag set");

    // 3) computeNextRunAt: if now is past HH:MM today, returns tomorrow
    const nineAm = new Date(2026, 0, 1, 9, 0, 0).getTime();
    const tenAm = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const sameDay = computeNextRunAt(nineAm - 1, 9, 0);
    const nextDay = computeNextRunAt(tenAm, 9, 0);
    assert(sameDay === nineAm, "before HH:MM today → today HH:MM");
    assert(nextDay === nineAm + 86_400_000, "after HH:MM today → tomorrow HH:MM");

    // 4) buildDigestPayload: empty RSS table → null (z1)
    const emptySettings = getOrCreateSettings();
    const emptyPayload = buildDigestPayload(emptySettings, Date.now());
    assert(emptyPayload === null, "no feeds → null payload");

    // 5) Insert feeds + articles, verify aggregation + cap to top N
    insertFeed("f1", "Tech News");
    insertFeed("f2", "Cooking Blog");
    insertFeed("f3", "Design Weekly");

    // f1: 5 unread articles
    for (let i = 0; i < 5; i++) {
      insertArticle({
        feedId: "f1",
        guid: `f1-${i}`,
        title: `Tech article ${i}`,
        link: `https://example.com/f1/${i}`,
        pubDate: Date.now() - i * 60_000,
      });
    }
    // f2: 3 unread
    for (let i = 0; i < 3; i++) {
      insertArticle({
        feedId: "f2",
        guid: `f2-${i}`,
        title: `Cooking article ${i}`,
        link: `https://example.com/f2/${i}`,
        pubDate: Date.now() - i * 60_000,
      });
    }
    // f3: 1 unread
    insertArticle({
      feedId: "f3",
      guid: "f3-0",
      title: "Design article 0",
      link: "https://example.com/f3/0",
      pubDate: Date.now(),
    });

    // Configure settings with watermark=0 so all unread are included.
    getRssDigestDb()
      .prepare(`UPDATE rss_digest_settings SET last_digest_at = 0 WHERE id = 1`)
      .run();
    const settingsAll = getOrCreateSettings();

    const now = Date.now();
    const payload = buildDigestPayload(settingsAll, now);
    log("payload (3 feeds, 9 unread total)", payload);
    assert(payload !== null, "payload built");
    assert(payload!.totalUnread === 9, "totalUnread == 9");
    assert(payload!.feeds.length === 3, "3 feed groups");
    assert(payload!.feeds[0].unreadCount === 5, "f1 (5 unread) ranked first");
    assert(
      payload!.feeds[0].articles.length === DIGEST_MAX_ARTICLES_PER_FEED,
      `f1 capped at ${DIGEST_MAX_ARTICLES_PER_FEED} articles`,
    );

    // 6) Cap to top 10 feeds: insert 12 more feeds, then re-capture `now`
    //    AFTER all inserts so the SQL filter (pub_date <= ?) sees them.
    for (let i = 4; i < 16; i++) {
      insertFeed(`f${i}`, `Extra feed ${i}`);
      insertArticle({
        feedId: `f${i}`,
        guid: `f${i}-0`,
        title: `Extra ${i}`,
        link: `https://example.com/f${i}/0`,
        pubDate: Date.now(),
      });
    }
    const nowAfterInserts = Date.now();
    const payloadCapped = buildDigestPayload(settingsAll, nowAfterInserts);
    log("payload (13 feeds total, top 10 returned)", payloadCapped);
    assert(payloadCapped !== null, "capped payload built");
    assert(
      payloadCapped!.feeds.length === DIGEST_MAX_FEEDS,
      `capped at ${DIGEST_MAX_FEEDS} feeds`,
    );

    // 7) Watermark filters: only articles past lastDigestAt
    const yesterday = Date.now() - 86_400_000;
    getRssDigestDb()
      .prepare(`UPDATE rss_digest_settings SET last_digest_at = ? WHERE id = 1`)
      .run(yesterday);
    const settingsFiltered = getOrCreateSettings();
    const payloadFiltered = buildDigestPayload(settingsFiltered, nowAfterInserts);
    log("payload (watermark = yesterday, all articles newer)", payloadFiltered);
    assert(payloadFiltered !== null, "filtered payload non-null");

    // Set watermark to now+1h — nothing should be included
    getRssDigestDb()
      .prepare(`UPDATE rss_digest_settings SET last_digest_at = ? WHERE id = 1`)
      .run(nowAfterInserts + 3_600_000);
    const settingsEmpty = getOrCreateSettings();
    const payloadNone = buildDigestPayload(settingsEmpty, nowAfterInserts);
    assert(payloadNone === null, "future watermark → null payload (z1)");

    // 8) countFeedsWithUnread returns the unpadded total
    getRssDigestDb()
      .prepare(`UPDATE rss_digest_settings SET last_digest_at = 0 WHERE id = 1`)
      .run();
    const settingsCount = getOrCreateSettings();
    const totalFeeds = countFeedsWithUnread(settingsCount, nowAfterInserts);
    log("countFeedsWithUnread", totalFeeds);
    assert(totalFeeds === 15, "15 feeds with unread");

    // 9) buildDigestBody: with no cap (feeds.length === totalFeedCount),
    //    header is "X feeds"; with cap (feeds.length < totalFeedCount),
    //    header is "X of Y feeds".
    const bodyAll = buildDigestBody(
      { totalUnread: 9, feedCount: 3, feeds: payload!.feeds },
      3,
    );
    log("body (no cap)", bodyAll);
    assert(bodyAll.startsWith("3 feeds"), "no-cap header reflects 3 actual");
    assert(bodyAll.includes("Tech News (5)"), "feed line includes Tech News (5)");

    const bodyCapped = buildDigestBody(
      {
        totalUnread: payloadCapped!.totalUnread,
        feedCount: payloadCapped!.feeds.length,
        feeds: payloadCapped!.feeds,
      },
      15,
    );
    log("body (capped)", bodyCapped);
    assert(bodyCapped.startsWith("10 of 15 feeds"), "capped header reflects 10 of 15");

    // 10) Body truncation: feed titles × N feeds must truncate to ≤ 200 chars
    const longTitles = Array.from({ length: 10 }, (_, i) => ({
      unreadCount: 3,
      feedTitle: `A very long feed title #${i} `,
      articles: [],
    }));
    const longBody = buildDigestBody(
      { totalUnread: 30, feedCount: 10, feeds: longTitles },
      10,
    );
    log("body (long titles, length)", { length: longBody.length, body: longBody });
    assert(longBody.length <= 200, "body capped to 200 chars");

    // 11) validatePatch: rejects bad inputs
    try {
      validatePatch({ hour: 24 });
      assert(false, "hour=24 should throw");
    } catch (e) {
      assert(e instanceof RssDigestValidationError, "hour validation error class");
      assert((e as RssDigestValidationError).field === "hour", "field is hour");
    }
    try {
      validatePatch({ minute: -1 });
      assert(false, "minute=-1 should throw");
    } catch (e) {
      assert(e instanceof RssDigestValidationError, "minute validation error class");
    }
    try {
      validatePatch({ minUnread: 0 });
      assert(false, "minUnread=0 should throw");
    } catch (e) {
      assert(e instanceof RssDigestValidationError, "minUnread validation error class");
    }
    try {
      validatePatch({ enabled: "yes" as unknown as boolean });
      assert(false, "enabled=string should throw");
    } catch (e) {
      assert(e instanceof RssDigestValidationError, "enabled validation error class");
    }

    // 12) recordTickCompletion: advances next_run_at and last_digest_at
    const before = getOrCreateSettings();
    const newNextRun = computeNextRunAt(now + 86_400_000, 9, 0);
    recordTickCompletion({ now: now + 86_400_000, nextRunAt: newNextRun, lastDigestAt: now + 86_400_000 });
    const after = getOrCreateSettings();
    log("after recordTickCompletion", after);
    assert(after.lastDigestAt === now + 86_400_000, "watermark advanced");
    assert(after.nextRunAt === newNextRun, "nextRunAt advanced");

    // 13) Min unread gate (loop logic, not store): verify the body+payload
    // still get built above the threshold. Store doesn't enforce minUnread —
    // that's done in lib/rss/digest.ts.
    void before;

    console.log("\n✓ ALL TESTS PASSED");
  } catch (e) {
    console.error("\n✗ TEST FAILED:", e);
    if (e instanceof Error && e.stack) console.error(e.stack);
    cleanup();
    process.exit(1);
  } finally {
    cleanup();
  }
})();