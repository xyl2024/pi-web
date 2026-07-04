/**
 * /api/rss/fetch — POST { feedId?: string; url?: string } manual fetch.
 *
 * Two modes:
 *   - { feedId }: re-fetch the existing feed. Calls fetchAndRefreshFeed so
 *     the result is persisted and feeds.last_fetched_at / unread_count are
 *     updated.
 *   - { url }: dry-run preview. Fetches the URL with proxyFetch and returns
 *     the first ~500 chars of the body without persisting anything. Used
 *     by the UI as a "test before subscribing" affordance (left for future
 *     work; the current UI only calls the feedId path).
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { fetchAndRefreshFeed } from "@/lib/rss-store";
import { proxyFetch } from "@/lib/http-proxy";
import {
  RSS_DEFAULT_SIZE_LIMIT_BYTES,
  RSS_FETCH_TIMEOUT_MS,
  RssNotFoundError,
  RssValidationError,
  validateFeedUrl,
} from "@/lib/rss-schema";

const log = createLogger("api/rss/fetch");

const PREVIEW_CHARS = 500;
const PREVIEW_USER_AGENT = "pi-web/0.6 (+rss-preview)";

interface FetchBody {
  feedId?: unknown;
  url?: unknown;
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as FetchBody;
    if (typeof body.feedId === "string" && body.feedId.length > 0) {
      const result = await fetchAndRefreshFeed(body.feedId);
      log.info("rss manual fetch done", {
        feedId: body.feedId,
        ok: result.ok,
        durationMs: elapsedMs(startedAt),
      });
      return NextResponse.json({ result });
    }
    if (typeof body.url === "string" && body.url.length > 0) {
      const url = validateFeedUrl(body.url, "url");
      const controller = new AbortController();
      const result = await proxyFetch({
        method: "GET",
        url,
        headers: {
          "User-Agent": PREVIEW_USER_AGENT,
          Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
        },
        timeoutMs: RSS_FETCH_TIMEOUT_MS,
        sizeLimitBytes: RSS_DEFAULT_SIZE_LIMIT_BYTES,
        signal: controller.signal,
        logFields: { preview: true },
      });
      if (!result.ok) {
        return NextResponse.json(
          { ok: false, error: result.error, message: result.message },
          { status: result.error === "body_too_large" ? 502 : 504 },
        );
      }
      return NextResponse.json({
        ok: true,
        status: result.status,
        contentType: result.headers["content-type"] ?? null,
        preview: result.body.slice(0, PREVIEW_CHARS),
        size: result.size,
      });
    }
    throw new RssValidationError("body", "feedId or url is required");
  } catch (error) {
    if (error instanceof RssValidationError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: 400 });
    }
    if (error instanceof RssNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("rss fetch failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}