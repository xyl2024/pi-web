import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/sessions");

export async function GET(request: Request) {
  const startedAt = Date.now();
  const cwd = new URL(request.url).searchParams.get("cwd") || undefined;
  log.debug("list sessions requested", { cwd });
  try {
    const sessions = await listAllSessions(cwd);
    log.info("list sessions completed", {
      count: sessions.length,
      cwd,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ sessions });
  } catch (error) {
    log.error("list sessions failed", { error, cwd, durationMs: elapsedMs(startedAt) });
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
