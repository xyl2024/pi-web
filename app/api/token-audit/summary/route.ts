/**
 * GET /api/token-audit/summary?range=today|7d|30d|all&groupBy=none|session|model|day&sessionId=...
 *
 * Returns `{ buckets, totals }` aggregated from token_calls. Range defaults to
 * "7d", groupBy defaults to "none". Mirrors the response shape from
 * `lib/token-audit-store.summarize`.
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { summarize, type GroupBy, type Range } from "@/lib/token-audit-store";

const log = createLogger("api/token-audit-summary");

function parseRange(v: string | null): Range {
  return v === "today" || v === "7d" || v === "30d" || v === "all" ? v : "7d";
}
function parseGroupBy(v: string | null): GroupBy {
  return v === "session" || v === "model" || v === "day" || v === "hour" ? v : "none";
}

export async function GET(req: Request) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const range = parseRange(url.searchParams.get("range"));
    const groupBy = parseGroupBy(url.searchParams.get("groupBy"));
    const result = summarize(range, groupBy);
    log.info("token-audit summary", {
      range,
      groupBy,
      buckets: result.buckets.length,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(result);
  } catch (error) {
    log.error("token-audit summary failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
