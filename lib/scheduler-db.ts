/**
 * SQLite-backed storage for scheduled tasks.
 *
 * Mirrors the singleton pattern in lib/db.ts: `better-sqlite3` is imported
 * only here, the handle is cached on `globalThis` so Next.js dev-mode HMR
 * doesn't reopen it on every reload. Separate file from todos.db because
 * the schemas are unrelated and the lifecycle (delete with cascade) should
 * not entangle the two domains.
 *
 * File location: `~/.pi-web/scheduler.db` by default, override with
 * `PI_WEB_SCHEDULER_DB` env var.
 */

import Database from "better-sqlite3";
import { dirname, join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";

declare global {
  var __piSchedulerDb: Database.Database | undefined;
}

function resolveDbPath(): string {
  const override = process.env.PI_WEB_SCHEDULER_DB?.trim();
  if (override) return override;
  return join(homedir(), ".pi-web", "scheduler.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    cron            TEXT NOT NULL,
    cwd             TEXT NOT NULL,
    prompt          TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    provider        TEXT,
    model_id        TEXT,
    thinking_level  TEXT,
    tool_names      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    last_run_at     INTEGER,
    next_run_at     INTEGER
  );

  CREATE TABLE IF NOT EXISTS task_runs (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    status      TEXT NOT NULL,
    reply_text  TEXT,
    error       TEXT,
    session_id  TEXT,
    duration_ms INTEGER,
    FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_task_runs_task_started
    ON task_runs(task_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled_next
    ON scheduled_tasks(enabled, next_run_at);
`;

export function getSchedulerDb(): Database.Database {
  if (globalThis.__piSchedulerDb) return globalThis.__piSchedulerDb;

  const dbPath = resolveDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  globalThis.__piSchedulerDb = db;
  return db;
}