/**
 * POST /api/scheduled-tasks/[id]/runs/mark-all-read
 *
 * Marks every run of a task as read. Returns the number of rows updated
 * so the client can show a confirmation ("3 runs marked as read").
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { getTask, markAllRunsRead, SchedulerNotFoundError } from "@/lib/scheduler-store";

const log = createLogger("api/scheduled-tasks/mark-all-read");

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  try {
    const { id } = await params;
    const task = getTask(id);
    if (!task) throw new SchedulerNotFoundError(id);

    const updated = markAllRunsRead(id);
    log.info("runs marked read", { id, updated, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ updated });
  } catch (error) {
    if (error instanceof SchedulerNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("mark-all-read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
