/**
 * SQLite-backed storage for the user's todo list.
 *
 * This is the only module that imports `better-sqlite3`. All other code paths
 * go through `getDb()` which returns a process-wide singleton cached on
 * `globalThis` so Next.js dev-mode HMR doesn't open a fresh handle on every
 * reload.
 *
 * File location: `~/.pi-web/todos.db` by default, override with
 * `PI_WEB_TODOS_DB` env var.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { createLogger } from "@/lib/logger";

const log = createLogger("todo-store");

declare global {
  var __piTodosDb: Database.Database | undefined;
  var __piTodosMigrated: boolean | undefined;
}

function resolveDbPath(): string {
  const override = process.env.PI_WEB_TODOS_DB?.trim();
  if (override) return override;
  return join(homedir(), ".pi-web", "todos.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS todos (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    description  TEXT,
    done         INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    completed_at INTEGER,
    deadline     INTEGER
  );

  CREATE TABLE IF NOT EXISTS todo_tags (
    todo_id TEXT NOT NULL,
    tag     TEXT NOT NULL,
    FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
  );

  -- Enforce case-insensitive uniqueness on (todo_id, tag) without
  -- requiring an expression in the PRIMARY KEY (not supported by SQLite).
  -- Matches the existing normalizeTags() semantics: first-seen casing
  -- is preserved on disk; case differences are rejected at the DB layer.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_tags_unique
    ON todo_tags(todo_id, lower(tag));

  CREATE INDEX IF NOT EXISTS idx_todos_done_created_at
    ON todos(done, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_todos_done_completed_at
    ON todos(done, completed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_todo_tags_tag
    ON todo_tags(tag);
`;

/** Runtime shape guard for entries read from the legacy `todos.json`. */
function isTodoShape(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.title === "string" &&
    typeof o.done === "boolean" &&
    typeof o.createdAt === "number" &&
    (o.description === undefined || typeof o.description === "string") &&
    (o.completedAt === undefined || typeof o.completedAt === "number") &&
    (o.deadline === undefined || typeof o.deadline === "number") &&
    (o.tags === undefined || (Array.isArray(o.tags) && o.tags.every((t) => typeof t === "string")))
  );
}

export function getDb(): Database.Database {
  if (globalThis.__piTodosDb) return globalThis.__piTodosDb;

  const dbPath = resolveDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  ensureTagColorColumn(db);

  globalThis.__piTodosDb = db;
  migrateFromJsonIfNeeded(db, dbPath);
  return db;
}

/**
 * One-shot column addition for `todo_tags.color`. The PRAGMA check makes this
 * safe to run on every `getDb()` call — it's a no-op once the column exists.
 * Adding the column is non-destructive: existing rows simply read back with
 * `color = NULL`, which the UI treats as "no color".
 */
function ensureTagColorColumn(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(todo_tags)").all() as { name: string }[];
  if (cols.some((c) => c.name === "color")) return;
  db.exec("ALTER TABLE todo_tags ADD COLUMN color TEXT");
}

/**
 * One-shot import from the legacy `~/.pi-web/todos.json` into the new DB.
 * Called from `getDb()` on first open. The original JSON is renamed (not
 * deleted) to `todos.json.migrated.<unix_ts>` so the data is preserved as
 * a fallback.
 */
function migrateFromJsonIfNeeded(db: Database.Database, dbPath: string): void {
  if (globalThis.__piTodosMigrated) return;
  globalThis.__piTodosMigrated = true;

  const jsonPath = join(dirname(dbPath), "todos.json");

  const totalTodosRow = db
    .prepare(`SELECT COUNT(*) AS c FROM todos`)
    .get() as { c: number };
  const totalTagsRow = db
    .prepare(`SELECT COUNT(*) AS c FROM todo_tags`)
    .get() as { c: number };
  const totalTodos = totalTodosRow.c;
  const totalTags = totalTagsRow.c;

  if (totalTodos > 0) {
    // DB already populated. The JSON may be a stale backup; do not re-import.
    return;
  }
  if (totalTags > 0) {
    log.error("refusing to migrate: todo_tags has rows but todos is empty", {
      jsonPath,
      totalTags,
    });
    return;
  }
  if (!existsSync(jsonPath)) return;

  let raw: string;
  try {
    raw = readFileSync(jsonPath, "utf-8");
  } catch (err) {
    log.error("failed to read todos.json for migration", { jsonPath, error: err });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Mirror readTodos() behavior: corrupt JSON = empty DB, leave the file
    // in place for manual recovery.
    log.error("todos.json is corrupt; starting with empty DB", { jsonPath, error: err });
    return;
  }
  if (!Array.isArray(parsed)) {
    log.error("todos.json is not an array; starting with empty DB", { jsonPath });
    return;
  }

  const valid: Array<{
    id: string;
    title: string;
    description?: string;
    done: boolean;
    createdAt: number;
    completedAt?: number;
    deadline?: number;
    tags: string[];
  }> = parsed.filter(isTodoShape).map((t) => {
    const o = t as Record<string, unknown>;
    return {
      id: o.id as string,
      title: o.title as string,
      description: o.description as string | undefined,
      done: o.done as boolean,
      createdAt: o.createdAt as number,
      completedAt: o.completedAt as number | undefined,
      deadline: o.deadline as number | undefined,
      tags: (Array.isArray(o.tags) ? (o.tags as string[]) : []),
    };
  });
  if (valid.length === 0) {
    log.info("todos.json had no valid entries; renaming", { jsonPath });
    renameToMigrated(jsonPath);
    return;
  }

  try {
    db.transaction(() => {
      const ins = db.prepare(`
        INSERT INTO todos (id, title, description, done, created_at, completed_at, deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const tagStmt = db.prepare(
        `INSERT INTO todo_tags (todo_id, tag) VALUES (?, ?)`,
      );
      for (const t of valid) {
        ins.run(
          t.id,
          t.title,
          t.description ?? null,
          t.done ? 1 : 0,
          t.createdAt,
          t.completedAt ?? null,
          t.deadline ?? null,
        );
        for (const tag of t.tags) tagStmt.run(t.id, tag);
      }
    })();
  } catch (err) {
    // Transaction is rolled back; the JSON stays put for retry.
    log.error("migration transaction failed; DB left empty", { jsonPath, error: err });
    return;
  }

  renameToMigrated(jsonPath);
  log.info("migrated todos.json → todos.db", {
    count: valid.length,
    jsonPath,
  });
}

function renameToMigrated(jsonPath: string): void {
  const backup = `${jsonPath}.migrated.${Math.floor(Date.now() / 1000)}`;
  try {
    renameSync(jsonPath, backup);
  } catch (err) {
    log.error("failed to rename todos.json after migration; leaving in place", {
      jsonPath,
      error: err,
    });
  }
}
