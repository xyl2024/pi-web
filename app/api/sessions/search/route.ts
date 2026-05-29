import { NextResponse } from "next/server";
import { searchSessions } from "@/lib/session-reader";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/sessions/search");

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");
  const q = url.searchParams.get("q");
  const startedAt = Date.now();
  log.debug("search sessions requested", { cwd, q });

  if (!cwd || !q?.trim()) {
    log.warn("search sessions missing params", { cwd, q, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: "cwd and q are required" }, { status: 400 });
  }

  try {
    const response = await searchSessions(cwd, q.trim());
    log.info("search sessions completed", {
      cwd,
      resultCount: response.results.length,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(response);
  } catch (error) {
    log.error("search sessions failed", { cwd, q, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
