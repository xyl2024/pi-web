/**
 * SQLite-backed storage for token usage audit.
 *
 * Mirrors the singleton pattern in `lib/scheduler-db.ts`: `better-sqlite3` is
 * imported only here, the handle is cached on `globalThis` so Next.js dev-mode
 * HMR doesn't reopen it on every reload. Separate file from todos.db / scheduler.db
 * / http-collections.db because the audit log's lifecycle and access pattern
 * (continuous INSERT per pi `message_end`, no cascade) shouldn't entangle with
 * any other domain.
 *
 * File location: `~/.pi-web/token-audit.db` by default, override with
 * `PI_WEB_TOKEN_AUDIT_DB` env var.
 */

import Database from "better-sqlite3";
import { dirname, join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { createLogger } from "./logger";

const log = createLogger("token-audit-db");

declare global {
  // eslint-disable-next-line no-var
  var __piTokenAuditDb: Database.Database | undefined;
}

function resolveDbPath(): string {
  const override = process.env.PI_WEB_TOKEN_AUDIT_DB?.trim();
  if (override) return override;
  return join(homedir(), ".pi-web", "token-audit.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS token_calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                INTEGER NOT NULL,
    session_id        TEXT    NOT NULL,
    message_id        TEXT    NOT NULL,
    source            TEXT    NOT NULL DEFAULT 'user',
    provider          TEXT    NOT NULL,
    model_id          TEXT    NOT NULL,
    api               TEXT,
    input_tokens      INTEGER NOT NULL DEFAULT 0,
    output_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_input  REAL NOT NULL DEFAULT 0,
    cost_output REAL NOT NULL DEFAULT 0,
    cost_read   REAL NOT NULL DEFAULT 0,
    cost_write  REAL NOT NULL DEFAULT 0,
    cost_total  REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    -- message_id is msg.timestamp (ms since epoch). Effectively unique within
    -- a session; collisions only happen when pi replays the same message
    -- (compaction / SSE reconnect), which is exactly what UNIQUE catches.
    -- AssistantMessage has no id on the in-memory object — the JSONL entry id
    -- sits outside, not available to extensions.
    UNIQUE(session_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_token_calls_ts             ON token_calls(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_token_calls_session_ts    ON token_calls(session_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_token_calls_provider_model ON token_calls(provider, model_id);
`;

export function getTokenAuditDb(): Database.Database {
  if (globalThis.__piTokenAuditDb) return globalThis.__piTokenAuditDb;

  const dbPath = resolveDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  globalThis.__piTokenAuditDb = db;
  log.info("token-audit db opened", { dbPath });
  return db;
}
