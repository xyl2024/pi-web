import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import {
  readAgentTodoHistory,
  readAgentTodoState,
} from "@/lib/agent-todo-store";
import { createLogger, elapsedMs } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createLogger("api/agent/[id]/agent-todo");

// GET /api/agent/[id]/agent-todo
// Returns the current task state + historyCount for initial panel hydration.
// A session with no agent_todo calls yet returns an empty state, not 404.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const startedAt = Date.now();
  log.debug("get agent-todo requested", { id });

  const filePath = await resolveSessionPath(id);
  if (!filePath) {
    // Session itself doesn't exist — surface 404 so the client can
    // distinguish "no session" from "session has no plan yet".
    log.warn("get agent-todo session not found", { id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const state = readAgentTodoState(id);
  const historyCount = readAgentTodoHistory(id).length;
  log.info("get agent-todo completed", {
    id,
    taskCount: state.tasks.length,
    historyCount,
    durationMs: elapsedMs(startedAt),
  });
  return NextResponse.json({
    tasks: state.tasks,
    nextId: state.nextId,
    historyCount,
  });
}