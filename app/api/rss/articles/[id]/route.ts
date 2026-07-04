/**
 * /api/rss/articles/[id] — PATCH (mark read / unread) one article.
 *
 * Body: { read: boolean }
 *
 * Marking read/unread also recomputes the parent feed's `unread_count`.
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { markArticleRead } from "@/lib/rss-store";
import {
  RssNotFoundError,
  RssValidationError,
  validateReadFlag,
} from "@/lib/rss-schema";

const log = createLogger("api/rss/articles/[id]");

interface PatchBody {
  read?: unknown;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as PatchBody;
    const read = validateReadFlag(body.read, "read");
    const article = markArticleRead(id, read);
    log.info("article marked", {
      id,
      read,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ article });
  } catch (error) {
    if (error instanceof RssValidationError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: 400 });
    }
    if (error instanceof RssNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("article patch failed", { id, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}