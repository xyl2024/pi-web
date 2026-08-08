import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { listRunningRpcSessions } from "@/lib/rpc-manager";
import { createLogger, elapsedMs } from "@/lib/logger";
import type { WorkspacesResponse, Workspace } from "@/lib/types";

export const dynamic = "force-dynamic";

const log = createLogger("api/workspaces");

interface Cursor {
  lastUsed: string;
  cwd: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.lastUsed === "string" && typeof parsed.cwd === "string") {
      return { lastUsed: parsed.lastUsed, cwd: parsed.cwd };
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * GET /api/workspaces
 *
 * Query params:
 *   - `limit`  page size; defaults to 5. The response always includes
 *              `nextCursor` when more rows are available.
 *   - `cursor` base64url-encoded `{lastUsed, cwd}` from the previous page.
 *              The next page starts strictly AFTER this point (both fields
 *              must be strictly less, ordered by lastUsed desc then cwd asc).
 *
 * Response: { workspaces: Workspace[], nextCursor: string | null }
 *
 * Sort order: lastUsed desc — i.e. cwd whose newest session was touched
 * most recently comes first. The active-cwd pin is applied by the client.
 */
export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const cursorRaw = url.searchParams.get("cursor");
  const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 0) : 5;
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;

  log.debug("list workspaces requested", { limit, hasCursor: !!cursor });
  try {
    // Single full scan under the 5s TTL covers both workspaces and the
    // existing /api/sessions route — they share loadAllSessionsCached.
    const all = await listAllSessions();

    // Group by cwd, picking the most-recently-modified session as the
    // aggregate "lastUsed" + tooltip source. Empty cwd strings are skipped
    // (no usable workspace identity).
    const byCwd = new Map<string, { lastUsed: string; firstSession: typeof all[number] }>();
    for (const s of all) {
      if (!s.cwd) continue;
      const existing = byCwd.get(s.cwd);
      if (!existing || s.modified > existing.lastUsed) {
        byCwd.set(s.cwd, { lastUsed: s.modified, firstSession: s });
      }
    }

    // Build a set of session ids that are currently running, partitioned
    // by cwd for the per-workspace runningCount.
    const runningByCwd = new Map<string, number>();
    for (const { id, running } of listRunningRpcSessions()) {
      if (!running) continue;
      const session = all.find((s) => s.id === id);
      if (!session?.cwd) continue;
      runningByCwd.set(session.cwd, (runningByCwd.get(session.cwd) ?? 0) + 1);
    }

    // Tally per-cwd session counts. One pass over `all` is enough.
    const countByCwd = new Map<string, number>();
    for (const s of all) {
      if (!s.cwd) continue;
      countByCwd.set(s.cwd, (countByCwd.get(s.cwd) ?? 0) + 1);
    }

    // Compose the Workspace rows from the precomputed maps.
    const rows: Workspace[] = [];
    for (const [cwd, info] of byCwd) {
      rows.push({
        cwd,
        lastUsed: info.lastUsed,
        totalSessions: countByCwd.get(cwd) ?? 0,
        runningCount: runningByCwd.get(cwd) ?? 0,
        firstMessage: info.firstSession.firstMessage,
        latestSessionName: info.firstSession.name,
      });
    }

    // Sort: lastUsed desc, with cwd as a tie-breaker so the cursor is stable.
    rows.sort((a, b) => {
      const t = b.lastUsed.localeCompare(a.lastUsed);
      return t !== 0 ? t : a.cwd.localeCompare(b.cwd);
    });

    // Apply cursor — start strictly after the cursor row.
    let startIdx = 0;
    if (cursor) {
      const idx = rows.findIndex(
        (r) => r.lastUsed === cursor.lastUsed && r.cwd === cursor.cwd,
      );
      if (idx >= 0) startIdx = idx + 1;
    }

    const page = rows.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < rows.length;
    const nextCursor = hasMore && page.length > 0
      ? encodeCursor({ lastUsed: page[page.length - 1].lastUsed, cwd: page[page.length - 1].cwd })
      : null;

    const response: WorkspacesResponse = {
      workspaces: page,
      nextCursor,
    };

    log.info("list workspaces completed", {
      returned: page.length,
      total: rows.length,
      hasNextCursor: nextCursor !== null,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(response);
  } catch (error) {
    log.error("list workspaces failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json(
      { error: String(error) },
      { status: 500 },
    );
  }
}