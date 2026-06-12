/**
 * Todo storage — SQLite-backed (via lib/db.ts).
 *
 * The public API (types, validation, exported function signatures) is
 * preserved from the previous JSON-file implementation so the HTTP routes,
 * the agent tool wrappers, and the React layer need no changes.
 *
 * The first parameter on the mutating functions (`filePath: string`) is
 * kept for source compatibility with prior call sites but is no longer
 * used — all reads and writes go through the singleton DB handle.
 */

import { getDb } from "@/lib/db";

export interface Todo {
  id: string;
  title: string;
  description?: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
  deadline?: number;
  tags: string[];
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_TAG_LENGTH = 50;

export type DeadlineFilter = "overdue" | "today" | "thisWeek" | "noDeadline";

export interface TodoCreateInput {
  title: string;
  description?: string;
  deadline?: number;
  tags?: string[];
}

export interface TodoUpdateInput {
  title?: string;
  description?: string;
  done?: boolean;
  deadline?: number | null;
  tags?: string[] | null;
}

export interface TodoListOptions {
  done?: boolean;
  search?: string;
  deadlineFilter?: DeadlineFilter;
  tags?: string[];
  limit?: number;
  now?: number;
}

export class TodoValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "TodoValidationError";
  }
}

export class TodoNotFoundError extends Error {
  constructor(id: string) {
    super("todo not found");
    this.name = "TodoNotFoundError";
    this.id = id;
  }
  public readonly id: string;
}

// ---------------------------------------------------------------------------
// Validation helpers — ported verbatim from the JSON implementation so the
// public contract of createTodo / updateTodo / normalizeTags is unchanged.
// ---------------------------------------------------------------------------

function validateTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new TodoValidationError("title must be a string", "title");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TodoValidationError("title cannot be empty", "title");
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new TodoValidationError("title is too long", "title");
  }
  return trimmed;
}

function validateOptionalDeadline(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TodoValidationError("deadline must be a number", "deadline");
  }
  return value;
}

/**
 * Normalize a tag list: trim each entry, drop empties, dedupe case-insensitively
 * (preserving the first occurrence's original casing). Used at every write site
 * so the stored array is always canonical.
 */
export function normalizeTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TodoValidationError("tags must be an array of strings", "tags");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new TodoValidationError("tags must be an array of strings", "tags");
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_TAG_LENGTH) {
      throw new TodoValidationError("tag is too long", "tags");
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function generateTodoId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Row mapping — SQLite row (with a `tags_json` column from the SELECT in
// listTodos) → Todo. Centralized so the column-to-field mapping is in one
// place.
// ---------------------------------------------------------------------------

interface TodoRow {
  id: string;
  title: string;
  description: string | null;
  done: number;
  created_at: number;
  completed_at: number | null;
  deadline: number | null;
  tags_json?: string;
}

function parseTagsJson(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {
    /* fall through */
  }
  return [];
}

function rowToTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    done: row.done === 1,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    deadline: row.deadline ?? undefined,
    tags: parseTagsJson(row.tags_json),
  };
}

// ---------------------------------------------------------------------------
// Public CRUD — signatures preserved from the JSON implementation.
// ---------------------------------------------------------------------------

export function createTodo(_filePath: string, input: TodoCreateInput): Todo {
  const title = validateTitle(input.title);
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new TodoValidationError("description must be a string", "description");
  }
  const description = input.description;
  const deadline = validateOptionalDeadline(input.deadline);
  const tags = normalizeTags(input.tags);

  const id = generateTodoId();
  const createdAt = Date.now();
  const db = getDb();

  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO todos (id, title, description, done, created_at, deadline)
       VALUES (?, ?, ?, 0, ?, ?)`,
    ).run(id, title, description ?? null, createdAt, deadline ?? null);
    const tagStmt = db.prepare(
      `INSERT INTO todo_tags (todo_id, tag) VALUES (?, ?)`,
    );
    for (const t of tags) tagStmt.run(id, t);
  });
  insert();

  return {
    id,
    title,
    description,
    done: false,
    createdAt,
    deadline,
    tags,
  };
}

export function updateTodo(_filePath: string, id: string, patch: TodoUpdateInput): Todo {
  if (typeof id !== "string") {
    throw new TodoValidationError("id must be a string", "id");
  }
  const db = getDb();

  const apply = db.transaction(() => {
    const row = db
      .prepare(`SELECT * FROM todos WHERE id = ?`)
      .get(id) as TodoRow | undefined;
    if (!row) throw new TodoNotFoundError(id);
    const next: Todo = rowToTodo(row);

    if (patch.title !== undefined) {
      next.title = validateTitle(patch.title);
    }
    if (patch.description !== undefined) {
      if (typeof patch.description !== "string") {
        throw new TodoValidationError("description must be a string", "description");
      }
      next.description = patch.description;
    }
    if (patch.done !== undefined) {
      if (typeof patch.done !== "boolean") {
        throw new TodoValidationError("done must be a boolean", "done");
      }
      // Server manages completedAt: false→true stamps, true→false clears.
      if (patch.done !== next.done) {
        next.done = patch.done;
        next.completedAt = patch.done ? Date.now() : undefined;
      }
    }
    if (patch.deadline !== undefined) {
      if (patch.deadline === null) {
        delete next.deadline;
      } else if (typeof patch.deadline !== "number" || !Number.isFinite(patch.deadline)) {
        throw new TodoValidationError("deadline must be a number or null", "deadline");
      } else {
        next.deadline = patch.deadline;
      }
    }
    if (patch.tags !== undefined) {
      if (patch.tags === null) {
        next.tags = [];
      } else {
        next.tags = normalizeTags(patch.tags);
      }
    }

    db.prepare(
      `UPDATE todos
         SET title = ?, description = ?, done = ?,
             completed_at = ?, deadline = ?
       WHERE id = ?`,
    ).run(
      next.title,
      next.description ?? null,
      next.done ? 1 : 0,
      next.completedAt ?? null,
      next.deadline ?? null,
      id,
    );
    db.prepare(`DELETE FROM todo_tags WHERE todo_id = ?`).run(id);
    const tagStmt = db.prepare(
      `INSERT INTO todo_tags (todo_id, tag) VALUES (?, ?)`,
    );
    for (const t of next.tags) tagStmt.run(id, t);
    return next;
  });
  return apply();
}

export function deleteTodo(_filePath: string, id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new TodoValidationError("id is required", "id");
  }
  const db = getDb();
  const result = db.prepare(`DELETE FROM todos WHERE id = ?`).run(id);
  if (result.changes === 0) throw new TodoNotFoundError(id);
}

/** Look up a single todo by id. Used by the export route. */
export function getTodoById(id: string): Todo | undefined {
  if (typeof id !== "string" || id.length === 0) return undefined;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT t.*, COALESCE(
         (SELECT json_group_array(tag) FROM todo_tags WHERE todo_id = t.id),
         '[]'
       ) AS tags_json
         FROM todos t
        WHERE t.id = ?`,
    )
    .get(id) as TodoRow | undefined;
  return row ? rowToTodo(row) : undefined;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * List todos with optional filters. Filter and sort semantics mirror the UI
 * in components/TodoPanel.tsx so the agent sees the same buckets the user
 * does.
 */
export function listTodos(_filePath: string, opts: TodoListOptions = {}): Todo[] {
  const db = getDb();
  const now = opts.now ?? Date.now();
  const startOfToday = startOfDay(now);
  const startOfTomorrow = startOfToday + 24 * 60 * 60 * 1000;
  // "本周内" = 本周一 ~ 本周日（含今天）。endOfThisWeek 取"下周一 0 点"。
  const dayOfWeek = new Date(now).getDay();
  const daysToEndOfWeek = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const endOfThisWeek = startOfToday + daysToEndOfWeek * 24 * 60 * 60 * 1000;
  const term = opts.search?.trim().toLowerCase() ?? "";

  const rows = db
    .prepare(
      `SELECT t.*, COALESCE(
         (SELECT json_group_array(tag) FROM todo_tags WHERE todo_id = t.id),
         '[]'
       ) AS tags_json
         FROM todos t`,
    )
    .all() as TodoRow[];

  const todos = rows.map(rowToTodo);
  const filtered = todos.filter((x) => {
    if (opts.done !== undefined && x.done !== opts.done) return false;
    switch (opts.deadlineFilter) {
      case undefined:
        break;
      case "overdue":
        if (x.done || x.deadline === undefined || x.deadline >= startOfToday) return false;
        break;
      case "today":
        if (x.done || x.deadline === undefined || x.deadline < startOfToday || x.deadline >= startOfTomorrow) return false;
        break;
      case "thisWeek":
        if (x.done || x.deadline === undefined || x.deadline < startOfToday || x.deadline >= endOfThisWeek) return false;
        break;
      case "noDeadline":
        if (x.deadline !== undefined) return false;
        break;
    }
    if (term) {
      const inTitle = x.title.toLowerCase().includes(term);
      const inDesc = (x.description ?? "").toLowerCase().includes(term);
      if (!inTitle && !inDesc) return false;
    }
    if (opts.tags && opts.tags.length > 0) {
      const wanted = new Set(opts.tags.map((t) => t.toLowerCase()));
      if (!x.tags.some((t) => wanted.has(t.toLowerCase()))) return false;
    }
    return true;
  });

  const sortKey: keyof Todo = opts.done === true ? "completedAt" : "createdAt";
  filtered.sort((a, b) => {
    if (opts.done === undefined && a.done !== b.done) {
      return a.done ? 1 : -1; // active first, done last
    }
    const av = (a[sortKey] as number | undefined) ?? 0;
    const bv = (b[sortKey] as number | undefined) ?? 0;
    return bv - av;
  });

  if (typeof opts.limit === "number" && opts.limit >= 0) {
    return filtered.slice(0, opts.limit);
  }
  return filtered;
}
