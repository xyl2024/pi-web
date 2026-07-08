import { NextResponse } from "next/server";
import {
  deleteAll,
  deleteBySource,
  deleteOlderThan,
  listMessages,
  listSources,
} from "@/lib/inbox-store";

export const dynamic = "force-dynamic";

/**
 * GET  /api/inbox/messages?since=<ms>&source=<s>&limit=<n>&sourcesOnly=1
 * DELETE /api/inbox/messages?all=1
 * DELETE /api/inbox/messages?source=<s>
 * DELETE /api/inbox/messages?olderThan=<ms>
 *
 * POST is intentionally not implemented — push is server-side only, driven by
 * lib/inbox-store.pushMessage() from the rss loop / scheduler runner / etc.
 * Clients that want to push a message must add a server-side source.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get("since");
  const source = url.searchParams.get("source");
  const limitRaw = url.searchParams.get("limit");
  const sourcesOnly = url.searchParams.get("sourcesOnly") === "1";

  if (sourcesOnly) {
    return NextResponse.json({ sources: listSources() });
  }

  const opts: Parameters<typeof listMessages>[0] = {};
  if (sinceRaw) {
    const n = Number(sinceRaw);
    if (Number.isFinite(n)) opts.since = n;
  }
  if (source) opts.source = source;
  if (limitRaw) {
    const n = Number(limitRaw);
    if (Number.isFinite(n) && n > 0) opts.limit = Math.min(Math.floor(n), 1000);
  }

  const messages = listMessages(opts);
  return NextResponse.json({ messages });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("all") === "1") {
    const deleted = deleteAll();
    return NextResponse.json({ ok: true, deleted });
  }
  const source = url.searchParams.get("source");
  if (source) {
    const deleted = deleteBySource(source);
    return NextResponse.json({ ok: true, deleted, source });
  }
  const olderThanRaw = url.searchParams.get("olderThan");
  if (olderThanRaw) {
    const n = Number(olderThanRaw);
    if (!Number.isFinite(n)) {
      return NextResponse.json(
        { error: "olderThan must be a number" },
        { status: 400 },
      );
    }
    const deleted = deleteOlderThan(n);
    return NextResponse.json({ ok: true, deleted, olderThan: n });
  }
  return NextResponse.json(
    { error: "DELETE requires one of: all=1, source=<s>, olderThan=<ms>" },
    { status: 400 },
  );
}