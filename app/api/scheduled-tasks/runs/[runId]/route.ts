/**
 * GET /api/scheduled-tasks/runs/[runId] — fetch a single run record.
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { getRun } from "@/lib/scheduler-store";

const log = createLogger("api/scheduled-tasks/run");

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const startedAt = Date.now();
  try {
    const { runId } = await params;
    const run = getRun(runId);
    if (!run) {
      return NextResponse.json({ error: "run not found" }, { status: 404 });
    }
    log.info("run fetched", { runId, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ run });
  } catch (error) {
    log.error("run fetch failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}