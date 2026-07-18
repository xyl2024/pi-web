/**
 * DELETE /api/token-audit/data — bulk-wipe all recorded token usage.
 *
 * Mirrors the DELETE-shape in `app/api/scheduled-tasks/route.ts:87-106`:
 * always returns 200 with `{ ok: true, deleted }` on success.
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { clearAllData } from "@/lib/token-audit-store";

const log = createLogger("api/token-audit-data");

export async function DELETE() {
  const startedAt = Date.now();
  try {
    const result = clearAllData();
    log.info("token-audit cleared via api", {
      deleted: result.deleted,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(result);
  } catch (error) {
    log.error("token-audit clear failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
