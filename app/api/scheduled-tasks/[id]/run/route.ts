/**
 * POST /api/scheduled-tasks/[id]/run — manually fire a task right now.
 *
 * Records a new `running` row, kicks the runner, returns the run id. The
 * client can poll /api/scheduled-tasks/runs/[runId] for status, or just
 * refresh the task's runs list.
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { getTask, recordRunStart, SchedulerNotFoundError } from "@/lib/scheduler-store";
import { runTask } from "@/lib/scheduler/runner";

const log = createLogger("api/scheduled-tasks/run");

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  try {
    const { id } = await params;
    const task = getTask(id);
    if (!task) throw new SchedulerNotFoundError(id);
    const run = recordRunStart(task.id);
    // Fire-and-forget — runner updates the run row on completion.
    void runTask(task, run.id);
    log.info("task triggered manually", { id, runId: run.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ runId: run.id });
  } catch (error) {
    if (error instanceof SchedulerNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("manual run failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}