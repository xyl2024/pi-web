import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildSessionContext } from "@/lib/session-reader";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/sessions/[id]/context");

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const startedAt = Date.now();
  log.debug("get session context requested", { id, leafId });

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      log.warn("get session context not found", { id, leafId, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = SessionManager.open(filePath);
    const context = buildSessionContext(sm.getEntries() as never, leafId);

    log.info("get session context completed", {
      id,
      leafId,
      messageCount: context.messages.length,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ context });
  } catch (error) {
    log.error("get session context failed", { id, leafId, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
