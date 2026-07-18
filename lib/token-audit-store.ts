/**
 * CRUD + aggregate queries for `token_calls`. Mirrors the conventions in
 * `lib/scheduler-store.ts`: snake_case SQL columns, typed `Row` interface,
 * `rowToCall()` mapper, prepared-statement lookups.
 *
 * Writes use `INSERT OR IGNORE` (with `UNIQUE(session_id, message_id)` from
 * the schema) because pi can replay `message_end` events across SSE
 * reconnects and during compaction rebuilds — a duplicate row must be
 * silently skipped, not surface as a `SqliteError`.
 *
 * Types and pure helpers live in sibling client-safe modules
 * (`lib/token-audit-types.ts`, `lib/hour-series.ts`) so the panel can
 * `import type` from them without dragging `better-sqlite3` / `fs` into
 * the client bundle. The re-exports below are kept for backward compat
 * with existing server-side callers.
 */

import { getTokenAuditDb } from "./token-audit-db";
import { createLogger } from "./logger";
import { parseLocalHourKey } from "./hour-series";
import type {
  HourBucket,
  Range,
  GroupBy,
  SummarizeResult,
  SummaryBucket,
  Source,
  TokenCall,
  TokenCallInsert,
  ListCallsParams,
} from "./token-audit-types";

const log = createLogger("token-audit-store");

// Re-export types so existing server-side callers don't have to change.
export type { HourBucket, Range, GroupBy, Source, SummaryBucket, SummarizeResult, TokenCall, TokenCallInsert, ListCallsParams };

interface Row {
  id: number;
  ts: number;
  session_id: string;
  message_id: string;
  source: string;
  provider: string;
  model_id: string;
  api: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_input: number;
  cost_output: number;
  cost_read: number;
  cost_write: number;
  cost_total: number;
  duration_ms: number;
  error: string | null;
}

function rowToCall(r: Row): TokenCall {
  return {
    id: r.id,
    ts: r.ts,
    sessionId: r.session_id,
    messageId: r.message_id,
    source: (r.source === "scheduled" ? "scheduled" : "user") as Source,
    provider: r.provider,
    modelId: r.model_id,
    api: r.api,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    costInput: r.cost_input,
    costOutput: r.cost_output,
    costRead: r.cost_read,
    costWrite: r.cost_write,
    costTotal: r.cost_total,
    durationMs: r.duration_ms,
    error: r.error,
  };
}

/** Compute the lower-bound epoch-ms for a range, or null for "all". */
function rangeCutoff(range: Range): number | null {
  const now = Date.now();
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (range === "7d") return now - 7 * 86_400_000;
  if (range === "30d") return now - 30 * 86_400_000;
  return null;
}

const INSERT_SQL = `
  INSERT OR IGNORE INTO token_calls
    (ts, session_id, message_id, source, provider, model_id, api,
     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
     cost_input, cost_output, cost_read, cost_write, cost_total,
     duration_ms, error)
  VALUES
    (@ts, @sessionId, @messageId, @source, @provider, @modelId, @api,
     @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
     @costInput, @costOutput, @costRead, @costWrite, @costTotal,
     @durationMs, @error)
`;

export function recordCall(input: TokenCallInsert): void {
  const db = getTokenAuditDb();
  db.prepare(INSERT_SQL).run(input);
}

export function listCalls(p: ListCallsParams): { rows: TokenCall[]; total: number } {
  const db = getTokenAuditDb();
  const cutoff = rangeCutoff(p.range);
  const whereParts: string[] = [];
  const args: unknown[] = [];
  if (cutoff !== null) {
    whereParts.push("ts >= ?");
    args.push(cutoff);
  }
  if (p.sessionId) {
    whereParts.push("session_id = ?");
    args.push(p.sessionId);
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM token_calls ${where}`)
    .get(...args) as { n: number };
  const rows = db
    .prepare(
      `SELECT * FROM token_calls ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, p.limit, p.offset) as Row[];

  return { rows: rows.map(rowToCall), total: totalRow.n };
}

const AGG_COLS = `
  COUNT(*)                     AS calls,
  SUM(input_tokens)            AS inputTokens,
  SUM(output_tokens)           AS outputTokens,
  SUM(cache_read_tokens)       AS cacheReadTokens,
  SUM(cache_write_tokens)      AS cacheWriteTokens,
  SUM(cost_total)              AS costTotal,
  SUM(duration_ms)             AS durationMs,
  MIN(ts)                      AS firstAt,
  MAX(ts)                      AS lastAt
`;

interface AggregateRow {
  key: string;
  calls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costTotal: number | null;
  durationMs: number | null;
  firstAt: number | null;
  lastAt: number | null;
}

function rowToBucket(r: AggregateRow): SummaryBucket {
  return {
    key: r.key,
    calls: r.calls ?? 0,
    inputTokens: r.inputTokens ?? 0,
    outputTokens: r.outputTokens ?? 0,
    cacheReadTokens: r.cacheReadTokens ?? 0,
    cacheWriteTokens: r.cacheWriteTokens ?? 0,
    costTotal: r.costTotal ?? 0,
    durationMs: r.durationMs ?? 0,
    firstAt: r.firstAt ?? 0,
    lastAt: r.lastAt ?? 0,
  };
}

function emptyBucket(): SummaryBucket {
  return {
    key: "*",
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costTotal: 0,
    durationMs: 0,
    firstAt: 0,
    lastAt: 0,
  };
}

export function summarize(range: Range, groupBy: GroupBy): SummarizeResult {
  const db = getTokenAuditDb();
  const cutoff = rangeCutoff(range);
  const where: string[] = [];
  const args: unknown[] = [];
  if (cutoff !== null) {
    where.push("ts >= ?");
    args.push(cutoff);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  if (groupBy === "none") {
    const row = db
      .prepare(`SELECT ${AGG_COLS} FROM token_calls ${whereSql}`)
      .get(...args) as AggregateRow | undefined;
    const totals = row ? rowToBucket({ ...row, key: "*" }) : emptyBucket();
    return { buckets: [], totals };
  }

  if (groupBy === "hour") {
    // Hour-of-day buckets (local time), keyed by SQLite-format 'YYYY-MM-DD HH:00'.
    // We recover each bucket's tsMs (local-time hour boundary) by parsing the
    // returned key string — 'localtime' gives us back the same wall-clock hour
    // we wrote in, so going through Date in local time keeps us consistent.
    const hourCols = `
      (strftime('%Y-%m-%d %H:00', ts / 1000, 'unixepoch', 'localtime')) AS key,
      COUNT(*)                    AS calls,
      SUM(input_tokens)           AS inputTokens,
      SUM(output_tokens)          AS outputTokens,
      SUM(cache_read_tokens)      AS cacheReadTokens,
      SUM(cache_write_tokens)     AS cacheWriteTokens,
      SUM(cost_total)             AS costTotal,
      SUM(duration_ms)            AS durationMs,
      MIN(ts)                     AS firstAt,
      MAX(ts)                     AS lastAt
    `;
    const rows = db
      .prepare(
        `SELECT ${hourCols} FROM token_calls ${whereSql} GROUP BY key ORDER BY key ASC`,
      )
      .all(...args) as AggregateRow[];
    const buckets: HourBucket[] = rows.map((r) => {
      const b = rowToBucket(r);
      const tsMs = parseLocalHourKey(r.key);
      const avgDurationMs = b.calls > 0 ? b.durationMs / b.calls : 0;
      return { ...b, tsMs, avgDurationMs };
    });
    const totRow = db
      .prepare(`SELECT ${AGG_COLS} FROM token_calls ${whereSql}`)
      .get(...args) as AggregateRow | undefined;
    const totals = totRow ? rowToBucket({ ...totRow, key: "*" }) : emptyBucket();
    return { buckets, totals };
  }

  const groupExpr =
    groupBy === "session"
      ? "session_id"
      : groupBy === "model"
        ? "(provider || '/' || model_id)"
        : "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')";

  // Aggregate per bucket AND overall, in one pass, by UNION ALL.
  const rows = db
    .prepare(
      `
      SELECT ${groupExpr} AS key, ${AGG_COLS}
        FROM token_calls
        ${whereSql}
        GROUP BY key
      UNION ALL
      SELECT '*' AS key, ${AGG_COLS}
        FROM token_calls
        ${whereSql}
      `,
    )
    .all(...args, ...args) as AggregateRow[];

  const totals = emptyBucket();
  const buckets: SummaryBucket[] = [];
  for (const row of rows) {
    const b = rowToBucket(row);
    if (b.key === "*") {
      totals.calls = b.calls;
      totals.inputTokens = b.inputTokens;
      totals.outputTokens = b.outputTokens;
      totals.cacheReadTokens = b.cacheReadTokens;
      totals.cacheWriteTokens = b.cacheWriteTokens;
      totals.costTotal = b.costTotal;
      totals.durationMs = b.durationMs;
      totals.firstAt = b.firstAt;
      totals.lastAt = b.lastAt;
    } else {
      buckets.push(b);
    }
  }

  // Sort buckets by costTotal DESC, then by calls DESC as tiebreak.
  buckets.sort((a, b) => {
    if (b.costTotal !== a.costTotal) return b.costTotal - a.costTotal;
    return b.calls - a.calls;
  });

  return { buckets, totals };
}

export function clearAllData(): { ok: true; deleted: number } {
  const db = getTokenAuditDb();
  const before = (db.prepare("SELECT COUNT(*) AS n FROM token_calls").get() as { n: number }).n;
  db.exec("DELETE FROM token_calls");
  log.info("token-audit cleared", { deleted: before });
  return { ok: true, deleted: before };
}
