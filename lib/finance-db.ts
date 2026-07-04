/**
 * SQLite-backed storage for the daily-accounting (FinancePanel) feature.
 *
 * Independent of the other pi-web DBs so each feature can be backed up /
 * restored on its own schedule. Same singleton-via-globalThis pattern as
 * `lib/http-collections-db.ts` so Next.js dev-mode HMR doesn't open a fresh
 * handle on every reload.
 *
 * File location: `~/.pi-web/finance.db` by default, override with
 * `PI_WEB_FINANCE_DB` env var.
 *
 * Migration story:
 *   v1: transactions(note), budgets
 *   v2: transactions(details), categories added (note column dropped)
 *
 * The migration runs on every open; each step is guarded by `PRAGMA
 * table_info(...)` so it's idempotent and safe on fresh DBs.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { createLogger } from "@/lib/logger";

const log = createLogger("finance-db");

declare global {
  var __piFinanceDb: Database.Database | undefined;
}

function resolveDbPath(): string {
  const override = process.env.PI_WEB_FINANCE_DB?.trim();
  if (override) return override;
  return join(homedir(), ".pi-web", "finance.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS transactions (
    id         TEXT PRIMARY KEY,
    date       INTEGER NOT NULL,
    amount     REAL    NOT NULL,
    direction  TEXT    NOT NULL CHECK(direction IN ('income','expense')),
    category   TEXT    NOT NULL,
    details    TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_date_desc
    ON transactions(date DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_category
    ON transactions(category);

  CREATE TABLE IF NOT EXISTS budgets (
    category      TEXT PRIMARY KEY,
    monthly_limit REAL    NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    name       TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
`;

/**
 * Idempotent migrations: each step checks for the new column's existence
 * before altering. The transactions table was originally created with a
 * `note` column (v1); v2 renamed it to `details`. We add `details` if
 * missing, copy `note → details`, then drop `note`.
 */
function runMigrations(db: Database.Database): void {
  const txCols = db
    .prepare(`PRAGMA table_info(transactions)`)
    .all() as Array<{ name: string }>;
  const hasDetails = txCols.some((c) => c.name === "details");
  const hasNote = txCols.some((c) => c.name === "note");

  if (!hasDetails) {
    log.info("finance migration: adding transactions.details column");
    db.exec(`ALTER TABLE transactions ADD COLUMN details TEXT NOT NULL DEFAULT ''`);
  }
  if (hasNote) {
    log.info("finance migration: copying note → details then dropping note");
    db.exec(
      `UPDATE transactions SET details = COALESCE(note, '') WHERE details = ''`,
    );
    db.exec(`ALTER TABLE transactions DROP COLUMN note`);
  }
}

export function getFinanceDb(): Database.Database {
  if (globalThis.__piFinanceDb) return globalThis.__piFinanceDb;

  const dbPath = resolveDbPath();
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch (err) {
    log.error("failed to create finance db directory", { dbPath, error: err });
    throw err;
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  runMigrations(db);

  globalThis.__piFinanceDb = db;
  log.info("finance db opened", { dbPath });
  return db;
}

/** Exposed for tests / status routes that need the resolved path. */
export function resolveFinanceDbPath(): string {
  return resolveDbPath();
}