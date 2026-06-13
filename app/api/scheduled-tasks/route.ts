/**
 * /api/scheduled-tasks — CRUD on scheduled tasks.
 *
 * Mirrors app/api/todos/route.ts: a single route file with GET, POST,
 * PATCH, DELETE. Each mutation calls `reschedule()` so the loop picks up
 * changes immediately. PATCH uses body id (todos use query for DELETE;
 * we mirror that for symmetry).
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import {
  createTask,
  deleteTask,
  listTasks,
  SchedulerNotFoundError,
  SchedulerValidationError,
  updateTask,
  type CreateTaskInput,
  type UpdateTaskInput,
} from "@/lib/scheduler-store";
import { reschedule } from "@/lib/scheduler/loop";

const log = createLogger("api/scheduled-tasks");

export async function GET() {
  const startedAt = Date.now();
  try {
    const tasks = listTasks();
    log.info("tasks listed", { count: tasks.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ tasks });
  } catch (error) {
    log.error("tasks list failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json()) as Partial<CreateTaskInput>;
    const task = createTask({
      name: body.name as string,
      cron: body.cron as string,
      cwd: body.cwd as string,
      prompt: body.prompt as string,
      enabled: body.enabled,
      provider: body.provider,
      modelId: body.modelId,
      thinkingLevel: body.thinkingLevel,
      toolNames: body.toolNames,
    });
    reschedule();
    log.info("task created via api", { id: task.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ task });
  } catch (error) {
    if (error instanceof SchedulerValidationError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: 400 });
    }
    log.error("task create failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json()) as Partial<UpdateTaskInput>;
    if (!body.id || typeof body.id !== "string") {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const task = updateTask(body as UpdateTaskInput);
    reschedule();
    log.info("task updated via api", { id: body.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ task });
  } catch (error) {
    if (error instanceof SchedulerValidationError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: 400 });
    }
    if (error instanceof SchedulerNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("task update failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id query param is required" }, { status: 400 });
    }
    deleteTask(id);
    reschedule();
    log.info("task deleted via api", { id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof SchedulerNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("task delete failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}