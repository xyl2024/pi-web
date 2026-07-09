import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/sessions");

export async function GET(request: Request) {
  const startedAt = Date.now();
  const cwd = new URL(request.url).searchParams.get("cwd") || undefined;
  log.debug("list sessions requested", { cwd });
  try {
    const sessions = await listAllSessions(cwd);
    // Enrich with running state from the wrapper registry. Sync Map lookup per
    // session — no awaits, so the cost is just N Map.get() calls.
    const enriched = sessions.map((s) => ({
      ...s,
      running: getRpcSession(s.id)?.isRunning() ?? false,
    }));
    log.info("list sessions completed", {
      count: enriched.length,
      cwd,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ sessions: enriched });
  } catch (error) {
    log.error("list sessions failed", { error, cwd, durationMs: elapsedMs(startedAt) });
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
