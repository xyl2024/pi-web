import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { getInFlightRegistry } from "@/lib/http-proxy";

export const dynamic = "force-dynamic";

const log = createLogger("api/http/cancel");

// POST /api/http/[id]/cancel
// Aborts the in-flight request identified by `id`. Idempotent — if the id
// is unknown (already finished, never existed), returns 204 with no body so
// the client can safely retry without surfacing a confusing error.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const startedAt = Date.now();
  try {
    const { id } = await params;
    if (!id) return jsonError("id required", 400);
    const registry = getInFlightRegistry();
    const handle = registry.get(id);
    if (!handle) {
      log.warn("cancel miss", { id, durationMs: elapsedMs(startedAt) });
      return new NextResponse(null, { status: 204 });
    }
    try {
      handle.controller.abort();
    } catch (err) {
      log.warn("cancel abort failed", { id, error: err, durationMs: elapsedMs(startedAt) });
    }
    log.info("cancel ok", { id, url: handle.url, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    log.error("cancel crashed", { error: err, durationMs: elapsedMs(startedAt) });
    return jsonError(err instanceof Error ? err.message : String(err), 500);
  }
}

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}