/**
 * SQLite-backed storage for HTTP request collections (the "Collections"
 * feature of the HTTP debug panel). See plan: `effervescent-imagining-hummingbird.md`.
 *
 * Independent of the todos DB so each feature can be backed up / restored on
 * its own schedule. Same singleton-via-globalThis pattern as `lib/db.ts` so
 * Next.js dev-mode HMR doesn't open a fresh handle on every reload.
 *
 * File location: `~/.pi-web/http_collections.db` by default, override with
 * `PI_WEB_HTTP_COLLECTIONS_DB` env var.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { createLogger } from "@/lib/logger";

const log = createLogger("http-collections-db");

declare global {
  var __piHttpCollectionsDb: Database.Database | undefined;
}

function resolveDbPath(): string {
  const override = process.env.PI_WEB_HTTP_COLLECTIONS_DB?.trim();
  if (override) return override;
  return join(homedir(), ".pi-web", "http_collections.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS collections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    method       TEXT NOT NULL,
    url          TEXT NOT NULL,
    params_json  TEXT NOT NULL DEFAULT '[]',
    headers_json TEXT NOT NULL DEFAULT '[]',
    body_mode    TEXT NOT NULL DEFAULT 'none',
    body         TEXT NOT NULL DEFAULT '',
    timeout_ms   INTEGER,
    tags_json    TEXT NOT NULL DEFAULT '[]',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS collection_items (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (collection_id, item_id)
  );

  CREATE INDEX IF NOT EXISTS idx_collection_items_item
    ON collection_items(item_id);
  CREATE INDEX IF NOT EXISTS idx_collections_created
    ON collections(created_at);
  CREATE INDEX IF NOT EXISTS idx_items_created
    ON items(created_at);
`;

export function getHttpCollectionsDb(): Database.Database {
  if (globalThis.__piHttpCollectionsDb) return globalThis.__piHttpCollectionsDb;

  const dbPath = resolveDbPath();
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch (err) {
    log.error("failed to create http_collections db directory", { dbPath, error: err });
    throw err;
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  globalThis.__piHttpCollectionsDb = db;
  log.info("http_collections db opened", { dbPath });
  return db;
}
