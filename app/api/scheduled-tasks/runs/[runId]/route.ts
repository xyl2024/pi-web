/**
 * GET   /api/scheduled-tasks/runs/[runId] — fetch a single run record.
 * PATCH /api/scheduled-tasks/runs/[runId] — toggle the read state.
 *        Body: { read: boolean }. true sets read_at = now, false clears it.
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { getRun, SchedulerNotFoundError, setRunRead } from "@/lib/scheduler-store";

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

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const startedAt = Date.now();
  try {
    const { runId } = await params;
    const body = (await req.json().catch(() => ({}))) as { read?: unknown };
    if (typeof body.read !== "boolean") {
      return NextResponse.json({ error: "read (boolean) is required" }, { status: 400 });
    }
    const run = setRunRead(runId, body.read);
    log.info("run read state updated", { runId, read: body.read, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ run });
  } catch (error) {
    if (error instanceof SchedulerNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("run read update failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}