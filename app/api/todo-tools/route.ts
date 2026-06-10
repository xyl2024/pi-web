import { NextResponse } from "next/server";
import { TODO_TOOL_NAMES, type TodoToolName } from "@/lib/todo-tools";
import { readEnabledTodoTools, writeEnabledTodoTools } from "@/lib/todo-tools-config";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/todo-tools");

// GET /api/todo-tools
export async function GET() {
  const startedAt = Date.now();
  try {
    const enabled = readEnabledTodoTools();
    log.info("todo tools read", { count: enabled.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ enabled, available: TODO_TOOL_NAMES });
  } catch (error) {
    log.error("todo tools read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PUT /api/todo-tools  body: { enabled: string[] }
export async function PUT(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as { enabled?: unknown };
    if (!Array.isArray(body.enabled)) {
      return NextResponse.json({ error: "enabled must be an array of tool names" }, { status: 400 });
    }
    const enabled = writeEnabledTodoTools(body.enabled as TodoToolName[]);
    log.info("todo tools updated", { count: enabled.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ enabled, available: TODO_TOOL_NAMES });
  } catch (error) {
    log.error("todo tools update failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
