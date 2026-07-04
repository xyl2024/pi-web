/**
 * /api/rss/articles/mark-all-read — POST { feedId } mark every unread article
 * for a feed as read.
 *
 * Returns the number of articles updated.
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { markAllArticlesRead } from "@/lib/rss-store";
import {
  RssNotFoundError,
  RssValidationError,
} from "@/lib/rss-schema";

const log = createLogger("api/rss/articles/mark-all-read");

interface MarkAllBody {
  feedId?: unknown;
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as MarkAllBody;
    if (typeof body.feedId !== "string" || body.feedId.length === 0) {
      throw new RssValidationError("feedId", "feedId must be a non-empty string");
    }
    const updated = markAllArticlesRead(body.feedId);
    log.info("articles marked all read", {
      feedId: body.feedId,
      updated,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ updated });
  } catch (error) {
    if (error instanceof RssValidationError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: 400 });
    }
    if (error instanceof RssNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("mark-all-read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}