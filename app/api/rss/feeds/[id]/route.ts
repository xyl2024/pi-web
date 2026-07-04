/**
 * /api/rss/feeds/[id] — PATCH (rename / trigger refresh) and DELETE one feed.
 *
 * `PATCH` body: { title?: string | null; refresh?: true }
 *   - title: rename the feed (validated, may be null to clear)
 *   - refresh: true → trigger fetchAndRefreshFeed synchronously and return
 *     the FetchResult alongside the feed.
 *
 * DELETE cascades to all rss_articles for this feed (ON DELETE CASCADE).
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import {
  deleteFeed,
  fetchAndRefreshFeed,
  updateFeed,
} from "@/lib/rss-store";
import {
  RssNotFoundError,
  RssValidationError,
} from "@/lib/rss-schema";

const log = createLogger("api/rss/feeds/[id]");

interface PatchBody {
  title?: unknown;
  refresh?: unknown;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as PatchBody;
    let refreshResult = null;
    if (body.refresh === true) {
      refreshResult = await fetchAndRefreshFeed(id);
    }
    const feed = updateFeed(id, {
      title: body.title === undefined ? undefined : (body.title as string | null),
    });
    log.info("feed patched", {
      id,
      refreshed: refreshResult !== null,
      ok: refreshResult?.ok ?? null,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ feed, refreshResult });
  } catch (error) {
    if (error instanceof RssValidationError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: 400 });
    }
    if (error instanceof RssNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("feed patch failed", { id, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const { id } = await params;
  try {
    deleteFeed(id);
    log.info("feed deleted", { id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    if (error instanceof RssNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("feed delete failed", { id, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}