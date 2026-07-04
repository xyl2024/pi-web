/**
 * /api/rss/feeds/[id]/articles — list articles for one feed.
 *
 * Query params:
 *   - unreadOnly=true to filter to unread
 *   - limit (1..500, default 500)
 *   - offset (default 0)
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { listArticles } from "@/lib/rss-store";
import { MAX_ARTICLES_PER_FEED } from "@/lib/rss-schema";

const log = createLogger("api/rss/feeds/[id]/articles");

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const { id } = await params;
  try {
    const url = new URL(req.url);
    const unreadOnly = url.searchParams.get("unreadOnly") === "true";
    const limitRaw = Number(url.searchParams.get("limit"));
    const offsetRaw = Number(url.searchParams.get("offset"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), MAX_ARTICLES_PER_FEED)
      : 500;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0
      ? Math.floor(offsetRaw)
      : 0;
    const articles = listArticles(id, { unreadOnly, limit, offset });
    log.info("articles listed", {
      feedId: id,
      count: articles.length,
      unreadOnly,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ articles });
  } catch (error) {
    log.error("articles list failed", {
      id,
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}