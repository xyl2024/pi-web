/**
 * GET /api/token-audit/calls?range=today|7d|30d|all&sessionId=...&limit=N&offset=N
 *
 * Returns `{ rows, total }`. Range defaults to "7d", limit default 100 / max 500,
 * offset default 0. Mirrors the response shape from `lib/token-audit-store.listCalls`.
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { listCalls, type Range } from "@/lib/token-audit-store";

const log = createLogger("api/token-audit-calls");

function parseRange(v: string | null): Range {
  return v === "today" || v === "7d" || v === "30d" || v === "all" ? v : "7d";
}
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export async function GET(req: Request) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const range = parseRange(url.searchParams.get("range"));
    const limit = clampInt(url.searchParams.get("limit"), 100, 1, 500);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const sessionId = url.searchParams.get("sessionId");
    const result = listCalls({ range, limit, offset, sessionId });
    log.info("token-audit calls", {
      range,
      sessionId,
      limit,
      offset,
      returned: result.rows.length,
      total: result.total,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(result);
  } catch (error) {
    log.error("token-audit calls failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
