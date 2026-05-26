import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/agent/[id]");

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const startedAt = Date.now();

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    const commandType = typeof body.type === "string" ? body.type : "unknown";
    log.info("agent command requested", { id, commandType });

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      log.info("agent command completed", {
        id,
        commandType,
        sessionSource: "existing",
        durationMs: elapsedMs(startedAt),
      });
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      log.warn("agent command session not found", { id, commandType, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();

    const { session } = await startRpcSession(id, filePath, cwd);
    const result = await session.send(body);

    log.info("agent command completed", {
      id,
      commandType,
      sessionSource: "started",
      cwd,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    log.error("agent command failed", { id, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const startedAt = Date.now();
  log.debug("agent state requested", { id });

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      log.debug("agent state completed", { id, running: false, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    log.debug("agent state completed", { id, running: true, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    log.error("agent state failed", { id, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
