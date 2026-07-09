import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { createLogger, elapsedMs } from "@/lib/logger";
import type { SessionInfo } from "@/lib/types";

const log = createLogger("api/sessions");

interface Cursor {
  modified: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.modified === "string" && typeof parsed.id === "string") {
      return { modified: parsed.modified, id: parsed.id };
    }
  } catch { /* fall through */ }
  return null;
}

function recentCwds(sessions: SessionInfo[], topN: number): string[] {
  const latestByCwd = new Map<string, string>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const prev = latestByCwd.get(s.cwd);
    if (!prev || s.modified > prev) latestByCwd.set(s.cwd, s.modified);
  }
  return [...latestByCwd.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, topN)
    .map(([cwd]) => cwd);
}

/**
 * GET /api/sessions
 *
 * Query params:
 *   - `cwd`     filter to a single workspace (already filtered at the SDK layer)
 *   - `limit`   page size; if absent the response returns ALL sessions
 *               (backward-compatible with existing unpaged callers — weixin
 *               workspace refresh, etc.). When present, `cursor` may follow.
 *   - `cursor`  base64url-encoded `{modified, id}` from the previous page's
 *               last row. The next page starts strictly AFTER this point.
 *
 * Response shape (always): { sessions, recentCwds, nextCursor? }
 * `nextCursor` is included only when `limit` was supplied; null means "no more".
 */
export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd") || undefined;
  const limitRaw = url.searchParams.get("limit");
  const cursorRaw = url.searchParams.get("cursor");
  const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 0) : 0;
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;

  log.debug("list sessions requested", { cwd, limit: limit || undefined, hasCursor: !!cursor });
  try {
    // Always scan the full set under the hood (cache hit within 5s) so the
    // recentCwds sidecar is accurate regardless of the cwd filter the caller
    // asked for. Cheap relative to the actual disk scan.
    const all = await listAllSessions();
    const recent = recentCwds(all, 5);

    // Filter the workspace subset the caller asked for, then enrich with running.
    const filtered = cwd ? all.filter((s) => s.cwd === cwd) : all;

    let page = filtered;
    let nextCursor: string | null = null;

    if (limit > 0) {
      // Slice starting strictly after the cursor. If the cursor's session
      // was deleted since the previous page, fall back to the start of the
      // list so the client still receives content. If the same id is found
      // but its `modified` timestamp has shifted (in-session activity since
      // the last page), start from idx+1 to skip past its new position —
      // this avoids re-emitting a row the client already has.
      let startIdx = 0;
      if (cursor) {
        const idx = filtered.findIndex((s) => s.id === cursor.id);
        if (idx >= 0) startIdx = idx + 1;
      }
      page = filtered.slice(startIdx, startIdx + limit);
      const hasMore = startIdx + limit < filtered.length;
      if (hasMore && page.length > 0) {
        nextCursor = encodeCursor({
          modified: page[page.length - 1].modified,
          id: page[page.length - 1].id,
        });
      } else {
        nextCursor = null;
      }
    }

    const enriched = page.map((s) => ({
      ...s,
      running: getRpcSession(s.id)?.isRunning() ?? false,
    }));

    log.info("list sessions completed", {
      returned: enriched.length,
      total: filtered.length,
      cwd,
      limit: limit || undefined,
      hasNextCursor: nextCursor !== null,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({
      sessions: enriched,
      recentCwds: recent,
      ...(limit > 0 ? { nextCursor } : {}),
    });
  } catch (error) {
    log.error("list sessions failed", { error, cwd, durationMs: elapsedMs(startedAt) });
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
