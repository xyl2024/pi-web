// GET /api/sessions/[id]/export?leafId=<id>&locale=<zh|en>
//
// Returns the current leaf of the requested session as a single-file HTML
// document. Self-contained: references to show_file paths are resolved
// against disk and inlined as `data:` URLs (up to 5 MB), so the resulting
// .html opens identically on the receiver's machine.
//
// Errors:
//   404  session id not found
//   400  explicit leafId query not present in the session tree
//   500  unexpected read/render failure

import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  resolveSessionPath,
  buildSessionContext,
} from "@/lib/session-reader";
import { createLogger, elapsedMs } from "@/lib/logger";
import { type Locale } from "@/lib/i18n-dict";
import { SHOW_FILE_TOOL_NAME } from "@/lib/show-file-tool-types";
import type { AgentMessage, SessionEntry } from "@/lib/types";
import {
  inlineFileByPath,
  type AttachmentResult,
} from "@/lib/session-export/inline-fs";
import { renderHtml } from "@/lib/session-export/render";
import { formatDate } from "@/lib/session-export/format";

const log = createLogger("api/sessions/[id]/export");

// Same shape as `slugifyTitle` in app/api/todos/[id]/export/route.ts:15-25,
// widened so CJK + accented titles round-trip without losing meaning.
function slugifyTitle(title: string, fallbackId: string): string {
  const cleaned = title
    .replace(/[^\p{L}\p{N}一-鿿]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : `session-${fallbackId.slice(0, 8)}`;
}

function parseLocale(raw: string | null): Locale {
  return raw === "zh" ? "zh" : "en";
}

interface SessionEntryLite {
  id: string;
}

function leafExists(entries: SessionEntryLite[], leafId: string): boolean {
  return entries.some((e) => e.id === leafId);
}

function collectShowFilePaths(messages: AgentMessage[]): string[] {
  const paths = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type !== "toolCall") continue;
      if (b.toolName !== SHOW_FILE_TOOL_NAME) continue;
      const raw = b.input?.paths;
      if (!Array.isArray(raw)) continue;
      for (const p of raw) {
        if (typeof p === "string" && p.length > 0) paths.add(p);
      }
    }
  }
  return [...paths];
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const url = new URL(req.url);
    const leafIdQuery = url.searchParams.get("leafId");
    const locale = parseLocale(url.searchParams.get("locale"));

    log.debug("export session requested", { id, leafId: leafIdQuery, locale });

    // 1. Resolve on-disk path; 404 if missing.
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      log.warn("export session not found", { id, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }

    // 2. Open the session via the SDK manager; reuse the same shape as
    // /api/sessions/[id] (route.ts:35-39 in this same package).
    const sm = SessionManager.open(filePath);
    const entries = sm.getEntries() as unknown as SessionEntry[];
    const defaultLeafId = sm.getLeafId();

    // 3. Validate explicit leafId (if caller passed one).
    const leafId = leafIdQuery ?? defaultLeafId ?? null;
    if (leafId && !leafExists(entries, leafId)) {
      log.warn("export session: leaf not found", {
        id, leafId, durationMs: elapsedMs(startedAt),
      });
      return NextResponse.json({ error: "leaf not found" }, { status: 400 });
    }

    // 4. Build the active-leaf context (messages / entryIds / thinkingLevel / model).
    const context = buildSessionContext(entries, leafId);

    // 5. Collect every path referenced by a show_file toolCall and inline it.
    const showFilePaths = collectShowFilePaths(context.messages);
    const attachments = new Map<string, AttachmentResult>();
    let inlined = 0;
    let skipped = 0;
    for (const p of showFilePaths) {
      const result = await inlineFileByPath(p);
      attachments.set(p, result);
      if (result.kind === "inline") inlined += 1;
      else skipped += 1;
    }

    // 6. Compose header metadata (minimal header per spec — no cwd, no tokens).
    const header = sm.getHeader() as { timestamp?: string } | null;
    const sessionName = (typeof sm.getSessionName === "function"
      ? sm.getSessionName()
      : "") ?? "";
    const title = sessionName.length > 0
      ? sessionName
      : `Session ${id.slice(0, 8)}`;
    const date = formatDate(header?.timestamp);
    const thinkingLevel = context.thinkingLevel ?? "";
    const modelLabel = context.model?.modelId ?? "";

    // 7. Render the self-contained HTML.
    const html = renderHtml({
      title,
      date,
      modelLabel,
      thinkingLevelLabel: thinkingLevel,
      locale,
      messages: context.messages,
      attachments,
    });

    // 8. Stream back with attachment Content-Disposition (UTF-8 slug).
    const slug = slugifyTitle(title, id);
    log.info("session exported", {
      id, slug, leafId, locale,
      inlined, skipped,
      htmlBytes: html.length,
      durationMs: elapsedMs(startedAt),
    });

    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(slug)}.html`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    log.error("export session failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
