import { listPayloads, getPayload } from "@/lib/payload-capture";
import { createLogger } from "@/lib/logger";
import { resolveEntryIdToIndex } from "@/lib/payload-resolve";

export const dynamic = "force-dynamic";

const log = createLogger("api/agent/[id]/payloads");

// GET /api/agent/[id]/payloads
//   Returns provider request/response payloads captured for this session.
//   Does NOT auto-start the session — if no wrapper has ever existed for
//   this id in this process, returns an empty list.
//
//   Optional query params:
//     - ?index=<n>     return a single entry by index
//     - ?entryId=<id>  return the entry for an assistant message id
//
//   For a lightweight view (status + duration only — no request body,
//   response headers), use /api/agent/[id]/payloads/summary?entryId=<id>.
//
//   Lookup order for ?entryId=:
//     1. Live wrapper's in-memory map (populated by message_start hooks).
//     2. Linear scan of the session file: the Nth assistant entry id maps
//        to payload index N-1 (payload indexes are 1:1 with assistant
//        messages on the default leaf, same assumption buildSessionContext
//        makes). Returns 404 if the entry id cannot be located.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const indexParam = url.searchParams.get("index");
  const entryIdParam = url.searchParams.get("entryId");

  if (indexParam !== null) {
    const parsed = Number.parseInt(indexParam, 10);
    if (!Number.isFinite(parsed)) {
      return Response.json({ error: "invalid index" }, { status: 400 });
    }
    const entry = getPayload(id, parsed);
    if (!entry) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(entry);
  }

  if (entryIdParam !== null) {
    const idx = await resolveEntryIdToIndex(id, entryIdParam);
    if (idx === null) {
      return Response.json({ error: "no payload for entry" }, { status: 404 });
    }
    const entry = getPayload(id, idx);
    if (!entry) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ ...entry, entryId: entryIdParam });
  }

  const items = listPayloads(id);
  log.debug("payload list requested", { id, count: items.length });
  return Response.json({ items });
}