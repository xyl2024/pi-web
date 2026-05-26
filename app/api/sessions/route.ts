import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/sessions");

export async function GET() {
  const startedAt = Date.now();
  log.debug("list sessions requested");
  try {
    const sessions = await listAllSessions();
    log.info("list sessions completed", {
      count: sessions.length,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ sessions });
  } catch (error) {
    log.error("list sessions failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
