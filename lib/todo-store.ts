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
import DOMPurify from "isomorphic-dompurify";
import { buildDescriptionSanitizeConfig } from "@/lib/description-sanitize";

export interface Tag {
  name: string;
  color?: string;
}

export interface Todo {
  id: string;
  title: string;
  description?: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
  deadline?: number;
  tags: Tag[];
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_TAG_LENGTH = 50;
// Hex colors only; canonicalized to lowercase before storage. Matches the
// format that <input type="color"> emits natively, so the picker round-trips.
// Reused by lib/description-sanitize.ts for the <span style="color:…"> filter.
export const TAG_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
export const MAX_DESCRIPTION_LENGTH = 100_000; // 100 KB — generous cap on raw HTML payload

export type DeadlineFilter = "overdue" | "today" | "thisWeek" | "noDeadline";

export interface TodoCreateInput {
  title: string;
  description?: string;
  deadline?: number;
  tags?: (Tag | string)[];
}

export interface TodoUpdateInput {
  title?: string;
  description?: string;
  done?: boolean;
  deadline?: number | null;
  tags?: (Tag | string)[] | null;
}

export interface TodoListOptions {
  done?: boolean;
  search?: string;
  deadlineFilter?: DeadlineFilter;
  tags?: string[];
  limit?: number;
  now?: number;
  /**
   * Inclusive lower bound on `createdAt` (epoch ms). Todos created before this
   * are excluded.
   */
  createdAfter?: number;
  /**
   * Exclusive upper bound on `createdAt` (epoch ms). Todos created at-or-after
   * this are excluded. Combine with `createdAfter` for a half-open
   * `[start, end)` window.
   */
  createdBefore?: number;
  /**
   * Inclusive lower bound on `deadline` (epoch ms). Todos with no deadline
   * (`deadline === undefined`) are excluded — they cannot satisfy a time
   * bound.
   */
  deadlineAfter?: number;
  /**
   * Exclusive upper bound on `deadline` (epoch ms). Same `undefined`-exclusion
   * rule as `deadlineAfter`.
   */
  deadlineBefore?: number;
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
 * Sanitize a todo description (HTML) for storage. Pass-through when input is
 * `undefined` (no change) or an empty string. Throws on non-string. The
 * resulting string is DOMPurify-cleaned against the shared description
 * allowlist (see lib/description-sanitize.ts) — `<script>`, inline event
 * handlers, `javascript:` URLs, and any tag/attribute outside the allowlist
 * are stripped before the row is written. `style="color: #rrggbb"` is the
 * only inline style that survives; everything else inside `style` is
 * dropped. Length-capped to MAX_DESCRIPTION_LENGTH (in raw characters,
 * pre-sanitize) to keep the SQLite column bounded.
 */
export function normalizeDescription(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TodoValidationError("description must be a string", "description");
  }
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    throw new TodoValidationError("description is too long", "description");
  }
  if (value.length === 0) return "";
  return DOMPurify.sanitize(value, buildDescriptionSanitizeConfig({ allowStyle: true }));
}

/**
 * Normalize a tag list: trim each entry, drop empties, dedupe case-insensitively
 * (preserving the first occurrence's original casing and color). Used at every
 * write site so the stored array is always canonical.
 *
 * Accepts either a `string` (e.g. "工作") or an object `{ name, color? }` per
 * element so agent tool callers that still send `string[]` keep working.
 */
export function normalizeTags(value: unknown): Tag[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TodoValidationError("tags must be an array", "tags");
  }
  const out: Tag[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    let name: string;
    let color: string | undefined;
    if (typeof raw === "string") {
      name = raw;
    } else if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      if (typeof o.name !== "string") {
        throw new TodoValidationError("tag.name must be a string", "tags");
      }
      name = o.name;
      if (o.color !== undefined && o.color !== null) {
        if (typeof o.color !== "string" || !TAG_COLOR_PATTERN.test(o.color)) {
          throw new TodoValidationError(
            "tag.color must be a hex color like #rrggbb",
            "tags",
          );
        }
        color = o.color.toLowerCase();
      }
    } else {
      throw new TodoValidationError("tag must be a string or { name, color? }", "tags");
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_TAG_LENGTH) {
      throw new TodoValidationError("tag is too long", "tags");
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: trimmed, color });
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

function parseTagsJson(raw: string | undefined): Tag[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: Tag[] = [];
    for (const item of parsed) {
      if (typeof item === "string") {
        // Defensive: legacy rows that pre-date the color column would have
        // been inserted as plain strings; treat them as color-less tags.
        if (item.length === 0) continue;
        out.push({ name: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.name !== "string" || o.name.length === 0) continue;
      const color = typeof o.color === "string" && o.color.length > 0 ? o.color : undefined;
      out.push({ name: o.name, color });
    }
    return out;
  } catch {
    return [];
  }
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
  const description = normalizeDescription(input.description);
  const deadline = validateOptionalDeadline(input.deadline);
  const tags = normalizeTags(input.tags);

  const id = generateTodoId();
  const createdAt = Date.now();
  const db = getDb();
  // Inherit the global color of any tag that's already in use elsewhere, so
  // new rows stay in sync with sibling rows for the same tag name. A caller
  // passing an explicit color wins; otherwise we fall back to the existing one.
  const existingColors = lookupExistingTagColors(
    db,
    tags.map((t) => t.name),
  );

  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO todos (id, title, description, done, created_at, deadline)
       VALUES (?, ?, ?, 0, ?, ?)`,
    ).run(id, title, description ?? null, createdAt, deadline ?? null);
    const tagStmt = db.prepare(
      `INSERT INTO todo_tags (todo_id, tag, color) VALUES (?, ?, ?)`,
    );
    for (const t of tags) {
      const color = t.color ?? existingColors.get(t.name.toLowerCase()) ?? null;
      tagStmt.run(id, t.name, color);
    }
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
    // Load the row together with its current tags from the separate
    // todo_tags table. A bare `SELECT *` only sees the todos columns, which
    // would leave `tags_json` undefined and cause rowToTodo() to report an
    // empty list — and the DELETE+re-INSERT below would then wipe the real
    // tags on every PATCH that doesn't carry an explicit `tags` field
    // (description edit, title rename, done toggle, deadline change, …).
    const row = db
      .prepare(
        `SELECT t.*, COALESCE(
           (SELECT json_group_array(json_object('name', tag, 'color', color))
              FROM todo_tags WHERE todo_id = t.id),
           '[]'
         ) AS tags_json
           FROM todos t
          WHERE t.id = ?`,
      )
      .get(id) as TodoRow | undefined;
    if (!row) throw new TodoNotFoundError(id);
    const next: Todo = rowToTodo(row);

    if (patch.title !== undefined) {
      next.title = validateTitle(patch.title);
    }
    if (patch.description !== undefined) {
      // The agent tool normalizes `null → undefined` before calling us, so
      // the only way normalizeDescription returns undefined here is the
      // "clear" path. Empty string is a valid description.
      const normalized = normalizeDescription(patch.description);
      if (normalized === undefined) {
        delete next.description;
      } else {
        next.description = normalized;
      }
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
    // Inherit the global color for tags that already have one. The new rows
    // for an existing tag take its current color; a tag with no history
    // gets NULL.
    const existingColors = lookupExistingTagColors(
      db,
      next.tags.map((t) => t.name),
    );
    const tagStmt = db.prepare(
      `INSERT INTO todo_tags (todo_id, tag, color) VALUES (?, ?, ?)`,
    );
    for (const t of next.tags) {
      const color = t.color ?? existingColors.get(t.name.toLowerCase()) ?? null;
      tagStmt.run(id, t.name, color);
    }
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

/**
 * Rename a tag globally. Every `todo_tags` row where `lower(tag) = lower(from)`
 * is rewritten to `to` inside a single transaction. Case-only renames are
 * honored so the user's spelling is preserved.
 *
 * Throws `TodoValidationError` if either side is invalid or if a target-tag
 * collision would violate `idx_todo_tags_unique` (i.e., a todo that currently
 * has the `from` tag also already has the `to` tag under a different spelling).
 * A no-op rename (no rows match) is legal and returns `affected: 0`.
 */
export function renameTag(_filePath: string, from: string, to: string): { tag: string; affected: number } {
  if (typeof from !== "string" || from.trim().length === 0) {
    throw new TodoValidationError("from must be a non-empty string", "from");
  }
  if (typeof to !== "string") {
    throw new TodoValidationError("to must be a string", "to");
  }
  const fromKey = from.trim();
  // Reuse normalizeTags so the destination gets the same trim/empty/length
  // treatment as a tag entered through the per-todo editor.
  const normalised = normalizeTags([to]);
  if (normalised.length === 0) {
    throw new TodoValidationError("tag cannot be empty", "to");
  }
  const toValue = normalised[0].name;

  const db = getDb();
  const apply = db.transaction(() => {
    // Collision check: for any todo that currently has `from`, is the target
    // tag already on it under a different spelling? The
    // `UNIQUE INDEX idx_todo_tags_unique ON (todo_id, lower(tag))` would
    // otherwise block the UPDATE.
    const conflict = db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM todo_tags
          WHERE todo_id IN (SELECT todo_id FROM todo_tags WHERE lower(tag) = lower(?))
            AND lower(tag) = lower(?)`,
      )
      .get(fromKey, toValue) as { c: number };
    if (conflict.c > 0) {
      throw new TodoValidationError("a todo already has the target tag", "to");
    }
    const result = db
      .prepare(`UPDATE todo_tags SET tag = ? WHERE lower(tag) = lower(?)`)
      .run(toValue, fromKey);
    return { tag: toValue, affected: result.changes };
  });
  return apply();
}

/**
 * Remove a tag from every todo that carries it. Case-insensitive match. A
 * no-op (no rows match) is legal and returns `affected: 0`.
 */
export function deleteTag(_filePath: string, tag: string): { tag: string; affected: number } {
  if (typeof tag !== "string" || tag.trim().length === 0) {
    throw new TodoValidationError("tag must be a non-empty string", "tag");
  }
  const tagKey = tag.trim();
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM todo_tags WHERE lower(tag) = lower(?)`)
    .run(tagKey);
  return { tag: tagKey, affected: result.changes };
}

/**
 * Set or clear the color of a tag globally. Every `todo_tags` row whose
 * `lower(tag)` matches is rewritten inside a single transaction, so all
 * chips for the same tag name flip in lockstep. `null` clears the color.
 *
 * A no-op (no rows match) is legal and returns `affected: 0`. The management
 * UI only surfaces tags with `count > 0`, so a stale tag with no current
 * todos cannot be reached via the picker — but the endpoint is forgiving
 * anyway so callers don't need to pre-check.
 */
export function setTagColor(
  _filePath: string,
  tag: string,
  color: string | null,
): { tag: string; color: string | null; affected: number } {
  if (typeof tag !== "string" || tag.trim().length === 0) {
    throw new TodoValidationError("tag must be a non-empty string", "tag");
  }
  let normalizedColor: string | null = null;
  if (color !== null) {
    if (typeof color !== "string" || !TAG_COLOR_PATTERN.test(color)) {
      throw new TodoValidationError(
        "color must be a hex color like #rrggbb or null",
        "color",
      );
    }
    normalizedColor = color.toLowerCase();
  }
  const tagKey = tag.trim();
  const db = getDb();
  const result = db
    .prepare(`UPDATE todo_tags SET color = ? WHERE lower(tag) = lower(?)`)
    .run(normalizedColor, tagKey);
  return { tag: tagKey, color: normalizedColor, affected: result.changes };
}

/**
 * Read the current color for each tag name in `tagNames`, returning a
 * `Map<lower-case-name, hex>` of tags that already have at least one colored
 * row. Used by `createTodo` / `updateTodo` so newly-inserted tag rows
 * inherit the global color and stay in sync with their siblings.
 */
function lookupExistingTagColors(
  db: ReturnType<typeof getDb>,
  tagNames: string[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (tagNames.length === 0) return map;
  const placeholders = tagNames.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT lower(tag) AS lk, color
         FROM todo_tags
        WHERE lower(tag) IN (${placeholders})
          AND color IS NOT NULL
        GROUP BY lower(tag)`,
    )
    .all(...tagNames.map((n) => n.toLowerCase())) as Array<{ lk: string; color: string }>;
  for (const row of rows) map.set(row.lk, row.color);
  return map;
}

/** Look up a single todo by id. Used by the export route. */
export function getTodoById(id: string): Todo | undefined {
  if (typeof id !== "string" || id.length === 0) return undefined;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT t.*, COALESCE(
         (SELECT json_group_array(json_object('name', tag, 'color', color))
            FROM todo_tags WHERE todo_id = t.id),
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
 *
 * Epoch-ms time windows (`createdAfter` / `createdBefore` / `deadlineAfter` /
 * `deadlineBefore`) are half-open: `start` is inclusive, `end` is exclusive.
 * The `deadline*` pair excludes todos without a deadline, since a todo with
 * `deadline === undefined` cannot satisfy "due after X".
 *
 * Sort order when `done` is unspecified:
 *   1. Active todos first, sorted by `deadline` ascending (soonest first;
 *      todos without a deadline sink to the bottom).
 *   2. Completed todos last, sorted by `completedAt` descending.
 * When `done === true`, only completed todos are returned (by `completedAt`
 * desc); when `done === false`, only active todos (by `deadline` asc, then
 * by `createdAt` desc as a tiebreaker).
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
         (SELECT json_group_array(json_object('name', tag, 'color', color))
            FROM todo_tags WHERE todo_id = t.id),
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
      if (!x.tags.some((t) => wanted.has(t.name.toLowerCase()))) return false;
    }
    if (opts.createdAfter !== undefined && x.createdAt < opts.createdAfter) return false;
    if (opts.createdBefore !== undefined && x.createdAt >= opts.createdBefore) return false;
    // deadlineAfter/Before intentionally exclude todos with no deadline: a
    // todo that has no deadline cannot satisfy "due after X" / "due before
    // Y". Callers that want to include them must omit the deadline filter.
    if (opts.deadlineAfter !== undefined) {
      if (x.deadline === undefined || x.deadline < opts.deadlineAfter) return false;
    }
    if (opts.deadlineBefore !== undefined) {
      if (x.deadline === undefined || x.deadline >= opts.deadlineBefore) return false;
    }
    return true;
  });

  // Sort: group active vs done, then order within each group. `undefined`
  // deadlines sink to the bottom of the active group so the agent sees the
  // most-urgent items first.
  const active = filtered.filter((x) => !x.done);
  const done = filtered.filter((x) => x.done);
  const cmpActive = (a: Todo, b: Todo): number => {
    if (a.deadline === undefined && b.deadline === undefined) {
      // Tiebreaker: most recently created first.
      return b.createdAt - a.createdAt;
    }
    if (a.deadline === undefined) return 1;
    if (b.deadline === undefined) return -1;
    if (a.deadline !== b.deadline) return a.deadline - b.deadline;
    return b.createdAt - a.createdAt;
  };
  const cmpDone = (a: Todo, b: Todo): number => {
    const av = a.completedAt ?? 0;
    const bv = b.completedAt ?? 0;
    return bv - av;
  };
  active.sort(cmpActive);
  done.sort(cmpDone);
  const ordered = [...active, ...done];

  if (typeof opts.limit === "number" && opts.limit >= 0) {
    return ordered.slice(0, opts.limit);
  }
  return ordered;
}
