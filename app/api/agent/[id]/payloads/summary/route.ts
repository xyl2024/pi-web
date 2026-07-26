import { getPayload } from "@/lib/payload-capture";
import { resolveEntryIdToIndex } from "@/lib/payload-resolve";

// GET /api/agent/[id]/payloads/summary?entryId=<id>
//
//   Lightweight counterpart to /api/agent/[id]/payloads. Returns only the
//   status code + wall-clock duration for one captured provider call, with
//   no request body or response headers. Used by the inline PayloadChip on
//   every assistant message so opening a long session doesn't pull N full
//   payloads over the wire.
//
//   Response: { index, status, durationMs } — same resolution rules as
//   /api/agent/[id]/payloads?entryId=. 404 if the entry id can't be mapped
//   to a payload index or the payload was never captured.
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const entryId = url.searchParams.get("entryId");

  if (entryId === null) {
    return Response.json({ error: "missing entryId" }, { status: 400 });
  }

  const idx = await resolveEntryIdToIndex(id, entryId);
  if (idx === null) {
    return Response.json({ error: "no payload for entry" }, { status: 404 });
  }
  const entry = getPayload(id, idx);
  if (!entry) return Response.json({ error: "not found" }, { status: 404 });

  const durationMs = entry.response
    ? entry.response.timestamp - entry.timestamp
    : null;
  return Response.json({
    index: entry.index,
    status: entry.response?.status ?? null,
    durationMs,
  });
}