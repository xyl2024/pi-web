/**
 * Client-safe shared types for the token-audit feature.
 *
 * Kept dependency-free so the panel and any other browser-side importer can
 * `import type` from here without dragging `better-sqlite3` / `fs` /
 * `@earendil-works/pi-coding-agent` into the client bundle.
 */

export type Range = "today" | "7d" | "30d" | "all";
export type GroupBy = "none" | "session" | "model" | "day" | "hour";
export type Source = "user" | "scheduled";

export interface TokenCall {
  id: number;
  ts: number;
  sessionId: string;
  messageId: string;
  source: Source;
  provider: string;
  modelId: string;
  api: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costInput: number;
  costOutput: number;
  costRead: number;
  costWrite: number;
  costTotal: number;
  durationMs: number;
  error: string | null;
}

export interface TokenCallInsert {
  sessionId: string;
  messageId: string;
  source: Source;
  provider: string;
  modelId: string;
  api: string | null;
  ts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costInput: number;
  costOutput: number;
  costRead: number;
  costWrite: number;
  costTotal: number;
  durationMs: number;
  error: string | null;
}

export interface SummaryBucket {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costTotal: number;
  durationMs: number;
  firstAt: number;
  lastAt: number;
  /** Average per-call duration. Present in `groupBy="hour"` output. */
  avgDurationMs?: number;
}

/** Hourly bucket — extends SummaryBucket with the absolute timestamp of the
 *  hour start, used by the 24h bar chart in the UI. */
export interface HourBucket extends SummaryBucket {
  /** Epoch-ms of the hour bucket's start (local-time hour boundary). */
  tsMs: number;
}

export interface ListCallsParams {
  range: Range;
  limit: number;
  offset: number;
  sessionId?: string | null;
}

export interface SummarizeResult {
  buckets: SummaryBucket[];
  totals: SummaryBucket;
}
