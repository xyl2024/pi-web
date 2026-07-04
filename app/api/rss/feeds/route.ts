/**
 * /api/rss/feeds — list and create RSS feeds.
 *
 * Mirrors app/api/scheduled-tasks/route.ts: a single route file with GET and
 * POST. POST triggers a fire-and-forget fetch so the user sees articles
 * immediately instead of waiting for the next 30-minute loop tick.
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import {
  createFeed,
  fetchAndRefreshFeed,
  listFeeds,
} from "@/lib/rss-store";
import {
  RssValidationError,
  validateFeedTitle,
  validateFeedUrl,
} from "@/lib/rss-schema";

const log = createLogger("api/rss/feeds");

export async function GET() {
  const startedAt = Date.now();
  try {
    const feeds = listFeeds();
    log.info("feeds listed", { count: feeds.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ feeds });
  } catch (error) {
    log.error("feeds list failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      url?: unknown;
      title?: unknown;
    };
    const url = validateFeedUrl(body.url, "url");
    const title = validateFeedTitle(body.title, "title");
    const feed = createFeed({ url, title });
    // Fire-and-forget first fetch — don't block the response on the network.
    void fetchAndRefreshFeed(feed.id).catch((err) => {
      log.warn("initial fetch threw", { feedId: feed.id, error: String(err) });
    });
    log.info("feed created", { id: feed.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ feed }, { status: 201 });
  } catch (error) {
    if (error instanceof RssValidationError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: 400 });
    }
    log.error("feed create failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}