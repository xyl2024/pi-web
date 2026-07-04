/**
 * SQLite-backed storage for the user's note list.
 *
 * Mirror of `lib/db.ts` for an independent notes domain. The notes table
 * has no `done` / `deadline` / `completed_at` columns — notes are free-form
 * content rather than actionable tasks. `note_tags` is a separate table
 * from `todo_tags`; the two domains share no tag namespace.
 *
 * File location: `~/.pi-web/notes.db` by default, override with
 * `PI_WEB_NOTES_DB` env var.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { createLogger } from "@/lib/logger";

const log = createLogger("notes-store");

declare global {
  var __piNotesDb: Database.Database | undefined;
}

function resolveDbPath(): string {
  const override = process.env.PI_WEB_NOTES_DB?.trim();
  if (override) return override;
  return join(homedir(), ".pi-web", "notes.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT 'Untitled',
    content    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS note_tags (
    note_id TEXT NOT NULL,
    tag     TEXT NOT NULL,
    color   TEXT,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_note_tags_unique
    ON note_tags(note_id, lower(tag));

  CREATE INDEX IF NOT EXISTS idx_notes_created_at
    ON notes(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_note_tags_tag
    ON note_tags(tag);
`;

export function getNotesDb(): Database.Database {
  if (globalThis.__piNotesDb) return globalThis.__piNotesDb;

  const dbPath = resolveDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  globalThis.__piNotesDb = db;
  log.info("opened notes db", { dbPath });
  return db;
}