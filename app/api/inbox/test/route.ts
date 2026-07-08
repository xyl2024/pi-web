import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { pushMessage } from "@/lib/inbox-store";
import { InboxValidationError } from "@/lib/inbox-schema";

export const dynamic = "force-dynamic";

const log = createLogger("api/inbox/test");

function validationResponse(err: InboxValidationError) {
  return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
}

/**
 * POST /api/inbox/test
 *
 * Test-only endpoint that pushes a single message into the Inbox. Lives on a
 * separate route from `/api/inbox/messages` because that one intentionally
 * does not implement POST (push is server-side only, driven by the rss loop
 * and scheduler runner). This route is itself server-side, but is the only
 * way to let a developer send a synthetic message from the UI (Settings →
 * Inbox Test) without waiting for a real RSS / scheduler event.
 *
 * Body shape:
 *   { source: string, level?: "info"|"warn"|"error", title: string,
 *     body?: string, href?: string }
 *
 * `body` and `href` are placed inside `payload` so the InboxModal renders
 * them the same way real messages do (see `InboxMessageRow`).
 */
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const raw = (await req.json().catch(() => ({}))) as {
      source?: unknown;
      level?: unknown;
      title?: unknown;
      body?: unknown;
      href?: unknown;
    };
    const payload: Record<string, unknown> = {};
    if (typeof raw.body === "string" && raw.body.length > 0) payload.body = raw.body;
    if (typeof raw.href === "string" && raw.href.length > 0) payload.href = raw.href;
    const message = pushMessage({
      source: raw.source as string,
      level: raw.level as "info" | "warn" | "error" | undefined,
      title: raw.title as string,
      ...(Object.keys(payload).length > 0 ? { payload } : {}),
    });
    log.info("test message pushed", {
      id: message.id,
      source: message.source,
      level: message.level,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ ok: true, message }, { status: 201 });
  } catch (error) {
    if (error instanceof InboxValidationError) return validationResponse(error);
    log.error("test push failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
