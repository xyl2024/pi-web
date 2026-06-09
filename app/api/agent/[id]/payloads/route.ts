import { listPayloads, getPayload } from "@/lib/payload-capture";
import { createLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createLogger("api/agent/[id]/payloads");

// GET /api/agent/[id]/payloads
//   Returns provider request/response payloads captured for this session
//   while the AgentSession was live in this process.
//   Does NOT auto-start the session — if no wrapper has ever existed
//   for this id in this process, returns an empty list.
//
//   Optional: ?index=<n> returns a single entry.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const indexParam = url.searchParams.get("index");

  if (indexParam !== null) {
    const parsed = Number.parseInt(indexParam, 10);
    if (!Number.isFinite(parsed)) {
      return Response.json({ error: "invalid index" }, { status: 400 });
    }
    const entry = getPayload(id, parsed);
    if (!entry) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(entry);
  }

  const items = listPayloads(id);
  log.debug("payload list requested", { id, count: items.length });
  return Response.json({ items });
}
