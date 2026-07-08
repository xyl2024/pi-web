/**
 * /api/rss/digest-settings — read + update the RSS daily digest settings.
 *
 * Mirrors `app/api/rss/feeds/route.ts` and `app/api/inbox/test/route.ts`:
 * validation errors map to 400 with `{ error, field }`; success returns the
 * updated settings + the recomputed `nextRunAt` so the client can refresh
 * its status row immediately.
 *
 * PUT also triggers `rescheduleDigestLoop()` so the loop's timer re-arms
 * to the new `next_run_at` without waiting for the current timer to fire.
 */
import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import {
  getSettings,
  updateSettings,
} from "@/lib/rss-digest-store";
import { RssDigestValidationError, validatePatch } from "@/lib/rss-digest-schema";
import { rescheduleDigestLoop } from "@/lib/rss/digest";

export const dynamic = "force-dynamic";

const log = createLogger("api/rss/digest-settings");

export async function GET() {
  const startedAt = Date.now();
  try {
    const settings = getSettings();
    log.info("digest settings read", { durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ settings });
  } catch (error) {
    log.error("digest settings read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const startedAt = Date.now();
  try {
    const raw = (await req.json().catch(() => ({}))) as unknown;
    const patch = validatePatch(raw);
    const { settings, rescheduled } = updateSettings(patch);
    if (rescheduled) {
      rescheduleDigestLoop();
    }
    log.info("digest settings updated", {
      enabled: settings.enabled,
      hour: settings.hour,
      minute: settings.minute,
      minUnread: settings.minUnread,
      nextRunAt: settings.nextRunAt,
      rescheduled,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ settings });
  } catch (error) {
    if (error instanceof RssDigestValidationError) {
      return NextResponse.json(
        { error: error.message, field: error.field },
        { status: 400 },
      );
    }
    log.error("digest settings update failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}