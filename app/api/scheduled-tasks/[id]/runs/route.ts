/**
 * GET /api/scheduled-tasks/[id]/runs — recent run history for a task.
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { getTask, listRuns, SchedulerNotFoundError } from "@/lib/scheduler-store";

const log = createLogger("api/scheduled-tasks/runs");

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  try {
    const { id } = await params;
    const task = getTask(id);
    if (!task) throw new SchedulerNotFoundError(id);

    const url = new URL(req.url);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 50;
    const runs = listRuns(id, Number.isFinite(limit) ? limit : 50);

    log.info("runs listed", { id, count: runs.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ runs });
  } catch (error) {
    if (error instanceof SchedulerNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("runs list failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}