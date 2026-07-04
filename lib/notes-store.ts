/**
 * Note storage — SQLite-backed (via lib/notes-db.ts).
 *
 * Mirror of `lib/todo-store.ts` for an independent notes domain. Notes
 * are free-form content rather than actionable tasks, so there are no
 * `done` / `deadline` / `completed_at` columns and no deadline filters.
 *
 * The mutating functions take a leading `_filePath: string` argument kept
 * for source compatibility with the `todo-store` shape but it is unused.
 */

import { getNotesDb } from "@/lib/notes-db";
import DOMPurify from "isomorphic-dompurify";
import { buildDescriptionSanitizeConfig } from "@/lib/description-sanitize";

export interface Tag {
  name: string;
  color?: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  tags: Tag[];
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_TAG_LENGTH = 50;
// Hex colors only; canonicalized to lowercase before storage. Matches the
// format that <input type="color"> emits natively. Reused by
// lib/description-sanitize.ts for the <span style="color:…"> filter.
export const TAG_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
// 1MB raw — notes are free-form so we allow a much larger HTML payload than
// todo descriptions. The DOMPurify config still applies on the way in.
export const MAX_CONTENT_LENGTH = 1_000_000;

export interface NoteCreateInput {
  title?: string;
  content?: string;
  tags?: (Tag | string)[];
}

export interface NoteUpdateInput {
  title?: string;
  content?: string;
  tags?: (Tag | string)[] | null;
}

export interface NoteListOptions {
  search?: string;
  tags?: string[];
  limit?: number;
}

export class NoteValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "NoteValidationError";
  }
}

export class NoteNotFoundError extends Error {
  constructor(id: string) {
    super("note not found");
    this.name = "NoteNotFoundError";
    this.id = id;
  }
  public readonly id: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate an optional title. Empty / missing is allowed and resolves to
 * "Untitled" so callers don't have to special-case the initial-create flow.
 * Whitespace is trimmed. Length-capped at MAX_TITLE_LENGTH.
 */
export function validateTitle(value: unknown): string {
  if (value === undefined || value === null) return "Untitled";
  if (typeof value !== "string") {
    throw new NoteValidationError("title must be a string", "title");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Untitled";
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new NoteValidationError("title is too long", "title");
  }
  return trimmed;
}

/**
 * Sanitize a note's content (HTML) for storage. The note body is Tiptap
 * HTML, so we pass it through the shared description allowlist (same as
 * todos) — `<script>`, inline event handlers, `javascript:` URLs, and any
 * tag/attribute outside the allowlist are stripped. `style="color: #rrggbb"`
 * is the only inline style that survives.
 *
 * Empty string is a valid content value (matches an empty / just-created
 * note). Length-capped to MAX_CONTENT_LENGTH (in raw characters, pre-sanitize).
 */
export function normalizeContent(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new NoteValidationError("content must be a string", "content");
  }
  if (value.length > MAX_CONTENT_LENGTH) {
    throw new NoteValidationError("content is too long", "content");
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
 * element so different callers stay flexible.
 */
export function normalizeTags(value: unknown): Tag[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new NoteValidationError("tags must be an array", "tags");
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
        throw new NoteValidationError("tag.name must be a string", "tags");
      }
      name = o.name;
      if (o.color !== undefined && o.color !== null) {
        if (typeof o.color !== "string" || !TAG_COLOR_PATTERN.test(o.color)) {
          throw new NoteValidationError(
            "tag.color must be a hex color like #rrggbb",
            "tags",
          );
        }
        color = o.color.toLowerCase();
      }
    } else {
      throw new NoteValidationError("tag must be a string or { name, color? }", "tags");
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_TAG_LENGTH) {
      throw new NoteValidationError("tag is too long", "tags");
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: trimmed, color });
  }
  return out;
}

export function generateNoteId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Row mapping — SQLite row → Note
// ---------------------------------------------------------------------------

interface NoteRow {
  id: string;
  title: string;
  content: string | null;
  created_at: number;
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

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content ?? "",
    createdAt: row.created_at,
    tags: parseTagsJson(row.tags_json),
  };
}

// ---------------------------------------------------------------------------
// Public CRUD
// ---------------------------------------------------------------------------

export function createNote(_filePath: string, input: NoteCreateInput): Note {
  const title = validateTitle(input.title);
  const content = normalizeContent(input.content);
  const tags = normalizeTags(input.tags);

  const id = generateNoteId();
  const createdAt = Date.now();
  const db = getNotesDb();
  // Inherit the global color of any tag that's already in use elsewhere so
  // new rows stay in sync with siblings. An explicit color wins.
  const existingColors = lookupExistingTagColors(
    db,
    tags.map((t) => t.name),
  );

  db.transaction(() => {
    db.prepare(
      `INSERT INTO notes (id, title, content, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(id, title, content, createdAt);
    const tagStmt = db.prepare(
      `INSERT INTO note_tags (note_id, tag, color) VALUES (?, ?, ?)`,
    );
    for (const t of tags) {
      const color = t.color ?? existingColors.get(t.name.toLowerCase()) ?? null;
      tagStmt.run(id, t.name, color);
    }
  })();

  return { id, title, content, createdAt, tags };
}

export function updateNote(_filePath: string, id: string, patch: NoteUpdateInput): Note {
  if (typeof id !== "string" || id.length === 0) {
    throw new NoteValidationError("id is required", "id");
  }
  const db = getNotesDb();

  return db.transaction(() => {
    // Same pattern as todo-store.ts: load the row with its tags_json so a
    // PATCH that omits `tags` doesn't accidentally wipe them.
    const row = db
      .prepare(
        `SELECT t.*, COALESCE(
           (SELECT json_group_array(json_object('name', tag, 'color', color))
              FROM note_tags WHERE note_id = t.id),
           '[]'
         ) AS tags_json
           FROM notes t
          WHERE t.id = ?`,
      )
      .get(id) as NoteRow | undefined;
    if (!row) throw new NoteNotFoundError(id);
    const next: Note = rowToNote(row);

    if (patch.title !== undefined) {
      next.title = validateTitle(patch.title);
    }
    if (patch.content !== undefined) {
      next.content = normalizeContent(patch.content);
    }
    if (patch.tags !== undefined) {
      if (patch.tags === null) {
        next.tags = [];
      } else {
        next.tags = normalizeTags(patch.tags);
      }
    }

    db.prepare(
      `UPDATE notes
         SET title = ?, content = ?
       WHERE id = ?`,
    ).run(next.title, next.content, id);

    db.prepare(`DELETE FROM note_tags WHERE note_id = ?`).run(id);
    const existingColors = lookupExistingTagColors(
      db,
      next.tags.map((t) => t.name),
    );
    const tagStmt = db.prepare(
      `INSERT INTO note_tags (note_id, tag, color) VALUES (?, ?, ?)`,
    );
    for (const t of next.tags) {
      const color = t.color ?? existingColors.get(t.name.toLowerCase()) ?? null;
      tagStmt.run(id, t.name, color);
    }
    return next;
  })();
}

export function deleteNote(_filePath: string, id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new NoteValidationError("id is required", "id");
  }
  const db = getNotesDb();
  const result = db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);
  if (result.changes === 0) throw new NoteNotFoundError(id);
}

/**
 * Rename a tag globally. Every `note_tags` row where `lower(tag) = lower(from)`
 * is rewritten to `to` inside a single transaction.
 *
 * Throws `NoteValidationError` if either side is invalid or if a target-tag
 * collision would violate `idx_note_tags_unique`. A no-op rename is legal.
 */
export function renameNoteTag(
  _filePath: string,
  from: string,
  to: string,
): { tag: string; affected: number } {
  if (typeof from !== "string" || from.trim().length === 0) {
    throw new NoteValidationError("from must be a non-empty string", "from");
  }
  if (typeof to !== "string") {
    throw new NoteValidationError("to must be a string", "to");
  }
  const fromKey = from.trim();
  const normalised = normalizeTags([to]);
  if (normalised.length === 0) {
    throw new NoteValidationError("tag cannot be empty", "to");
  }
  const toValue = normalised[0].name;

  const db = getNotesDb();
  return db.transaction(() => {
    const conflict = db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM note_tags
          WHERE note_id IN (SELECT note_id FROM note_tags WHERE lower(tag) = lower(?))
            AND lower(tag) = lower(?)`,
      )
      .get(fromKey, toValue) as { c: number };
    if (conflict.c > 0) {
      throw new NoteValidationError("a note already has the target tag", "to");
    }
    const result = db
      .prepare(`UPDATE note_tags SET tag = ? WHERE lower(tag) = lower(?)`)
      .run(toValue, fromKey);
    return { tag: toValue, affected: result.changes };
  })();
}

/**
 * Remove a tag from every note that carries it. Case-insensitive match.
 */
export function deleteNoteTag(_filePath: string, tag: string): { tag: string; affected: number } {
  if (typeof tag !== "string" || tag.trim().length === 0) {
    throw new NoteValidationError("tag must be a non-empty string", "tag");
  }
  const tagKey = tag.trim();
  const db = getNotesDb();
  const result = db
    .prepare(`DELETE FROM note_tags WHERE lower(tag) = lower(?)`)
    .run(tagKey);
  return { tag: tagKey, affected: result.changes };
}

/**
 * Set or clear the color of a tag globally. `null` clears the color.
 */
export function setNoteTagColor(
  _filePath: string,
  tag: string,
  color: string | null,
): { tag: string; color: string | null; affected: number } {
  if (typeof tag !== "string" || tag.trim().length === 0) {
    throw new NoteValidationError("tag must be a non-empty string", "tag");
  }
  let normalizedColor: string | null = null;
  if (color !== null) {
    if (typeof color !== "string" || !TAG_COLOR_PATTERN.test(color)) {
      throw new NoteValidationError(
        "color must be a hex color like #rrggbb or null",
        "color",
      );
    }
    normalizedColor = color.toLowerCase();
  }
  const tagKey = tag.trim();
  const db = getNotesDb();
  const result = db
    .prepare(`UPDATE note_tags SET color = ? WHERE lower(tag) = lower(?)`)
    .run(normalizedColor, tagKey);
  return { tag: tagKey, color: normalizedColor, affected: result.changes };
}

function lookupExistingTagColors(
  db: ReturnType<typeof getNotesDb>,
  tagNames: string[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (tagNames.length === 0) return map;
  const placeholders = tagNames.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT lower(tag) AS lk, color
         FROM note_tags
        WHERE lower(tag) IN (${placeholders})
          AND color IS NOT NULL
        GROUP BY lower(tag)`,
    )
    .all(...tagNames.map((n) => n.toLowerCase())) as Array<{ lk: string; color: string }>;
  for (const row of rows) map.set(row.lk, row.color);
  return map;
}

/** Look up a single note by id. */
export function getNoteById(id: string): Note | undefined {
  if (typeof id !== "string" || id.length === 0) return undefined;
  const db = getNotesDb();
  const row = db
    .prepare(
      `SELECT t.*, COALESCE(
         (SELECT json_group_array(json_object('name', tag, 'color', color))
            FROM note_tags WHERE note_id = t.id),
         '[]'
       ) AS tags_json
         FROM notes t
        WHERE t.id = ?`,
    )
    .get(id) as NoteRow | undefined;
  return row ? rowToNote(row) : undefined;
}

/**
 * List notes with optional filters. Sorted by `created_at DESC` (newest
 * first) — there is no "done" state for notes, so the bucketing from
 * `listTodos` does not apply.
 */
export function listNotes(_filePath: string, opts: NoteListOptions = {}): Note[] {
  const db = getNotesDb();
  const term = opts.search?.trim().toLowerCase() ?? "";

  const rows = db
    .prepare(
      `SELECT t.*, COALESCE(
         (SELECT json_group_array(json_object('name', tag, 'color', color))
            FROM note_tags WHERE note_id = t.id),
         '[]'
       ) AS tags_json
         FROM notes t`,
    )
    .all() as NoteRow[];

  const notes = rows.map(rowToNote);
  const filtered = notes.filter((x) => {
    if (term) {
      const inTitle = x.title.toLowerCase().includes(term);
      const inContent = x.content.toLowerCase().includes(term);
      if (!inTitle && !inContent) return false;
    }
    if (opts.tags && opts.tags.length > 0) {
      const wanted = new Set(opts.tags.map((t) => t.toLowerCase()));
      if (!x.tags.some((t) => wanted.has(t.name.toLowerCase()))) return false;
    }
    return true;
  });

  filtered.sort((a, b) => b.createdAt - a.createdAt);

  if (typeof opts.limit === "number" && opts.limit >= 0) {
    return filtered.slice(0, opts.limit);
  }
  return filtered;
}

/**
 * Return the list of distinct tags currently in use across notes, with the
 * number of notes carrying each one. Used by the management UI.
 */
export function listNoteTags(_filePath: string): Array<{ name: string; color: string | null; count: number }> {
  const db = getNotesDb();
  const rows = db
    .prepare(
      `SELECT tag, color, COUNT(*) AS c
         FROM note_tags
        GROUP BY lower(tag)
        ORDER BY lower(tag) ASC`,
    )
    .all() as Array<{ tag: string; color: string | null; c: number }>;
  return rows.map((r) => ({ name: r.tag, color: r.color, count: r.c }));
}