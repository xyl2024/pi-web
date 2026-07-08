/**
 * SQLite-backed CRUD for the Inbox message center.
 *
 * Mirror of `lib/http-collections-store.ts`: validation, custom error class,
 * row-to-type mapper. The Inbox is append-only by design — messages are
 * never updated in place. Only push (insert) and delete operations exist.
 * Reads are simple ORDER BY ts DESC queries, optionally filtered by `since`
 * and `source`.
 *
 * All reads go through the singleton DB handle in `lib/inbox-db.ts`. No
 * in-memory cache; freshness is the React layer's job (see
 * `hooks/useInbox.ts` and `hooks/useInboxUnreadCount.ts`).
 */

import { getInboxDb } from "@/lib/inbox-db";
import {
  type InboxMessage,
  type InboxPushInput,
  validateLevel,
  validatePayload,
  validateSource,
  validateTitle,
  generateInboxId,
} from "@/lib/inbox-schema";
import { createLogger } from "@/lib/logger";

const log = createLogger("inbox-store");

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface InboxRow {
  id: string;
  ts: number;
  source: string;
  level: string;
  title: string;
  payload_json: string | null;
}

function parsePayloadJson(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

function rowToMessage(row: InboxRow): InboxMessage {
  const payload = parsePayloadJson(row.payload_json);
  return {
    id: row.id,
    ts: row.ts,
    source: row.source,
    level: row.level as InboxMessage["level"],
    title: row.title,
    ...(payload ? { payload } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ListOptions {
  since?: number;
  source?: string;
  limit?: number;
}

export function pushMessage(input: InboxPushInput): InboxMessage {
  const source = validateSource(input.source);
  const level = validateLevel(input.level);
  const title = validateTitle(input.title);
  const payload = validatePayload(input.payload);

  const id = generateInboxId();
  const ts = Date.now();
  const db = getInboxDb();
  db.prepare(
    `INSERT INTO inbox_messages (id, ts, source, level, title, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ts,
    source,
    level,
    title,
    payload ? JSON.stringify(payload) : null,
  );

  log.info("pushed", { id, source, level });
  return { id, ts, source, level, title, ...(payload ? { payload } : {}) };
}

export function listMessages(opts: ListOptions = {}): InboxMessage[] {
  const db = getInboxDb();
  const where: string[] = [];
  const params: Array<number | string> = [];
  if (typeof opts.since === "number" && Number.isFinite(opts.since)) {
    where.push("ts > ?");
    params.push(Math.floor(opts.since));
  }
  if (typeof opts.source === "string" && opts.source.length > 0) {
    where.push("source = ?");
    params.push(opts.source);
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 1000));
  const sql =
    `SELECT id, ts, source, level, title, payload_json
       FROM inbox_messages
       ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY ts DESC
       LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...params) as InboxRow[];
  return rows.map(rowToMessage);
}

export function countMessages(): number {
  const row = getInboxDb()
    .prepare(`SELECT COUNT(*) AS c FROM inbox_messages`)
    .get() as { c: number };
  return row.c;
}

export function deleteByIds(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = getInboxDb();
  const placeholders = ids.map(() => "?").join(",");
  const result = db
    .prepare(`DELETE FROM inbox_messages WHERE id IN (${placeholders})`)
    .run(...ids);
  return result.changes;
}

export function deleteAll(): number {
  const result = getInboxDb()
    .prepare(`DELETE FROM inbox_messages`)
    .run();
  return result.changes;
}

export function deleteBySource(source: string): number {
  const result = getInboxDb()
    .prepare(`DELETE FROM inbox_messages WHERE source = ?`)
    .run(source);
  return result.changes;
}

export function deleteOlderThan(ts: number): number {
  const result = getInboxDb()
    .prepare(`DELETE FROM inbox_messages WHERE ts < ?`)
    .run(Math.floor(ts));
  return result.changes;
}

export function listSources(): Array<{ source: string; count: number }> {
  const rows = getInboxDb()
    .prepare(
      `SELECT source, COUNT(*) AS c
         FROM inbox_messages
         GROUP BY source
         ORDER BY c DESC`,
    )
    .all() as Array<{ source: string; c: number }>;
  return rows.map((r) => ({ source: r.source, count: r.c }));
}