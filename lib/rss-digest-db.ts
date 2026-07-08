/**
 * SQLite-backed storage for the RSS daily digest settings.
 *
 * Separate DB from `lib/rss-db.ts` so the digest settings can be backed up,
 * inspected, or wiped independently of the RSS feeds/articles — a one-row
 * table, no shared concerns. Same globalThis singleton pattern so Next.js
 * dev-mode HMR doesn't open a fresh handle on every reload.
 *
 * File location: `~/.pi-web/rss-digest.db` by default, override with
 * `PI_WEB_RSS_DIGEST_DB` env var.
 *
 * Schema:
 *   - `rss_digest_settings` is a singleton (CHECK id = 1). We enforce
 *     singleton via the CHECK constraint rather than just convention, so a
 *     buggy code path can't accidentally insert a second row.
 *   - `next_run_at` is nullable — null when disabled or not yet computed.
 *   - `last_digest_at` defaults to 0 so the first digest is "include every
 *     unread article" unless `enableDigest()` rebases it to now() (see
 *     `lib/rss/digest.ts`).
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { createLogger } from "@/lib/logger";

const log = createLogger("rss-digest-db");

declare global {
  var __piRssDigestDb: Database.Database | undefined;
}

function resolveDbPath(): string {
  const override = process.env.PI_WEB_RSS_DIGEST_DB?.trim();
  if (override) return override;
  return join(homedir(), ".pi-web", "rss-digest.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rss_digest_settings (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    enabled         INTEGER NOT NULL,
    hour            INTEGER NOT NULL,
    minute          INTEGER NOT NULL,
    min_unread      INTEGER NOT NULL,
    last_digest_at  INTEGER NOT NULL DEFAULT 0,
    next_run_at     INTEGER,
    updated_at      INTEGER NOT NULL
  );
`;

export function getRssDigestDb(): Database.Database {
  if (globalThis.__piRssDigestDb) return globalThis.__piRssDigestDb;

  const dbPath = resolveDbPath();
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch (err) {
    log.error("failed to create rss digest db directory", { dbPath, error: err });
    throw err;
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);

  globalThis.__piRssDigestDb = db;
  log.info("rss digest db opened", { dbPath });
  return db;
}