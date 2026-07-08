/**
 * SQLite-backed storage for the Inbox message center.
 *
 * Mirror of `lib/scheduler-db.ts` and `lib/http-collections-db.ts`:
 * - one table (`inbox_messages`) per file
 * - WAL + NORMAL synchronous for fast inserts
 * - globalThis singleton so Next.js dev-mode HMR doesn't reopen the handle
 *
 * File location: `~/.pi-web/inbox.db` by default, override with
 * `PI_WEB_INBOX_DB` env var.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { createLogger } from "./logger";

const log = createLogger("inbox-db");

declare global {
  var __piInboxDb: Database.Database | undefined;
}

function resolveDbPath(): string {
  const override = process.env.PI_WEB_INBOX_DB?.trim();
  if (override) return override;
  return join(homedir(), ".pi-web", "inbox.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS inbox_messages (
    id            TEXT PRIMARY KEY,
    ts            INTEGER NOT NULL,
    source        TEXT NOT NULL,
    level         TEXT NOT NULL DEFAULT 'info',
    title         TEXT NOT NULL,
    payload_json  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_messages_ts
    ON inbox_messages(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_inbox_messages_source_ts
    ON inbox_messages(source, ts DESC);
`;

export function getInboxDb(): Database.Database {
  if (globalThis.__piInboxDb) return globalThis.__piInboxDb;

  const dbPath = resolveDbPath();
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch (err) {
    log.error("failed to create inbox db directory", { dbPath, error: err });
    throw err;
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);

  globalThis.__piInboxDb = db;
  log.info("inbox db opened", { dbPath });
  return db;
}