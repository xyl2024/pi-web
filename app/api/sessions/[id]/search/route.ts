import { NextResponse } from "next/server";
import { resolveSessionPath, searchSessionMessages } from "@/lib/session-reader";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/sessions/[id]/search");

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  const startedAt = Date.now();
  log.debug("session message search requested", { sessionId: id, q });

  if (!q?.trim()) {
    log.warn("session message search missing param", { sessionId: id, q, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: "q is required" }, { status: 400 });
  }

  const filePath = await resolveSessionPath(id);
  if (!filePath) {
    log.warn("session message search session not found", { sessionId: id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  try {
    const response = await searchSessionMessages(filePath, q.trim());
    log.info("session message search completed", {
      sessionId: id,
      totalMatches: response.totalMatches,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(response);
  } catch (error) {
    log.error("session message search failed", { sessionId: id, q, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
