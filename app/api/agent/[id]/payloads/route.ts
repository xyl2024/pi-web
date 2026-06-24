import { readFileSync } from "node:fs";
import { listPayloads, getPayload } from "@/lib/payload-capture";
import { createLogger } from "@/lib/logger";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

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

/**
 * Resolve an assistant message entry id to its payload index.
 *
 * Fast path: the live wrapper's in-memory map. Fallback: count assistant
 * entries in the session file in linear order — the Nth assistant entry
 * corresponds to payload index N (payload indexes are 1:1 with assistant
 * messages on the default linear branch).
 */
async function resolveEntryIdToIndex(sessionId: string, entryId: string): Promise<number | null> {
  // Fast path — live wrapper memory.
  const wrapper = getRpcSession(sessionId);
  if (wrapper) {
    const idx = wrapper.getPayloadIndexForEntry(entryId);
    if (idx !== undefined) return idx;
  }

  // Cold path — scan the session file. We deliberately do NOT start a
  // wrapper here; this route is read-only.
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  let assistantIndex = -1;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { type?: unknown; id?: unknown; message?: { role?: unknown } };
    if (e.type !== "message" || !e.message) continue;
    if (e.message.role !== "assistant") continue;
    assistantIndex += 1;
    if (e.id === entryId) return assistantIndex;
  }
  return null;
}
