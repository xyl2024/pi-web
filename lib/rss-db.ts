/**
 * SQLite-backed storage for the RSS panel.
 *
 * Independent of the todos / scheduler / collections DBs so each feature can
 * be backed up / restored on its own schedule. Same singleton-via-globalThis
 * pattern as `lib/http-collections-db.ts` so Next.js dev-mode HMR doesn't open
 * a fresh handle on every reload.
 *
 * File location: `~/.pi-web/rss.db` by default, override with `PI_WEB_RSS_DB`
 * env var.
 *
 * Schema highlights:
 *   - `rss_articles (feed_id, guid)` is UNIQUE — we upsert by guid within a
 *     single feed. Same-guid articles in different feeds are treated as
 *     distinct rows (the feed boundary is the identity boundary).
 *   - ON DELETE CASCADE on `rss_articles.feed_id` — deleting a feed removes
 *     all of its articles. Requires `foreign_keys = ON` per connection.
 *   - The unread index is a partial index on `read_at IS NULL` so it's small
 *     and fast even when the bulk of the table is read.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { createLogger } from "@/lib/logger";

const log = createLogger("rss-db");

declare global {
  var __piRssDb: Database.Database | undefined;
}

function resolveDbPath(): string {
  const override = process.env.PI_WEB_RSS_DB?.trim();
  if (override) return override;
  return join(homedir(), ".pi-web", "rss.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rss_feeds (
    id              TEXT PRIMARY KEY,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT,
    etag            TEXT,
    last_modified   TEXT,
    last_fetched_at INTEGER,
    last_error      TEXT,
    unread_count    INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rss_articles (
    id           TEXT PRIMARY KEY,
    feed_id      TEXT NOT NULL REFERENCES rss_feeds(id) ON DELETE CASCADE,
    guid         TEXT NOT NULL,
    title        TEXT,
    link         TEXT,
    pub_date     INTEGER,
    content_html TEXT,
    content_text TEXT,
    fetched_at   INTEGER NOT NULL,
    read_at      INTEGER,
    UNIQUE (feed_id, guid)
  );

  CREATE INDEX IF NOT EXISTS idx_rss_articles_feed_pubdate
    ON rss_articles(feed_id, pub_date DESC);
  CREATE INDEX IF NOT EXISTS idx_rss_articles_feed_unread
    ON rss_articles(feed_id) WHERE read_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_rss_feeds_last_fetched
    ON rss_feeds(last_fetched_at);
`;

export function getRssDb(): Database.Database {
  if (globalThis.__piRssDb) return globalThis.__piRssDb;

  const dbPath = resolveDbPath();
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch (err) {
    log.error("failed to create rss db directory", { dbPath, error: err });
    throw err;
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  globalThis.__piRssDb = db;
  log.info("rss db opened", { dbPath });
  return db;
}