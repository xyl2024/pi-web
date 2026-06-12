#!/usr/bin/env node
/**
 * Rollback tool: read `~/.pi-web/todos.db` and write a fresh
 * `~/.pi-web/todos.json` (or a custom path). Use this if the SQLite-backed
 * code path needs to be reverted to the previous JSON-file implementation.
 *
 * Usage:
 *   npx tsx scripts/todos-restore.ts                            # defaults
 *   npx tsx scripts/todos-restore.ts --db=... --out=...         # custom paths
 *
 * If `--out` already exists, it is renamed to `<out>.restored.<ts>` first
 * (matches the migration's rename-not-delete safety).
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import Database from "better-sqlite3";

interface TodoRow {
  id: string;
  title: string;
  description: string | null;
  done: number;
  created_at: number;
  completed_at: number | null;
  deadline: number | null;
}

interface TagRow {
  todo_id: string;
  tag: string;
}

interface Todo {
  id: string;
  title: string;
  description?: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
  deadline?: number;
  tags: string[];
}

function parseArgs(argv: string[]): { dbPath: string; outPath: string } {
  const dbOverride = argv.find((a) => a.startsWith("--db="))?.slice("--db=".length);
  const outOverride = argv.find((a) => a.startsWith("--out="))?.slice("--out=".length);
  const dbPath = dbOverride ?? process.env.PI_WEB_TODOS_DB ?? join(homedir(), ".pi-web", "todos.db");
  const outPath = outOverride ?? join(homedir(), ".pi-web", "todos.json");
  return { dbPath, outPath };
}

function main(): void {
  const { dbPath, outPath } = parseArgs(process.argv.slice(2));

  if (!existsSync(dbPath)) {
    console.error(`No DB at ${dbPath}; nothing to restore.`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  let rows: TodoRow[];
  let tagRows: TagRow[];
  try {
    rows = db
      .prepare(
        `SELECT id, title, description, done,
                created_at, completed_at, deadline
           FROM todos`,
      )
      .all() as TodoRow[];
    tagRows = db
      .prepare(`SELECT todo_id, tag FROM todo_tags`)
      .all() as TagRow[];
  } finally {
    db.close();
  }

  const tagMap = new Map<string, string[]>();
  for (const { todo_id, tag } of tagRows) {
    const arr = tagMap.get(todo_id) ?? [];
    arr.push(tag);
    tagMap.set(todo_id, arr);
  }

  const todos: Todo[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description ?? undefined,
    done: r.done === 1,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? undefined,
    deadline: r.deadline ?? undefined,
    tags: tagMap.get(r.id) ?? [],
  }));

  if (existsSync(outPath)) {
    const backup = `${outPath}.restored.${Math.floor(Date.now() / 1000)}`;
    try {
      renameSync(outPath, backup);
      console.error(`Moved existing ${outPath} → ${backup}`);
    } catch (err) {
      console.error(`Failed to move existing ${outPath} out of the way:`, err);
      process.exit(1);
    }
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(todos, null, 2), "utf-8");
  console.error(`Wrote ${todos.length} todo(s) to ${outPath}`);
}

main();
