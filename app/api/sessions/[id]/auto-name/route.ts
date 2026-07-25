// POST /api/sessions/[id]/auto-name
//
// One-shot endpoint that asks the default model to generate a short title
// for the session based on the first user message. The route is atomic:
// it reads the session, checks whether a name already exists, calls the
// LLM, and writes the result (if any) before returning.
//
// All failure modes are silent: the client gets back a `skipped` reason
// rather than a 5xx, so the calling UI doesn't need any error handling.

import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, invalidateSessionListCache } from "@/lib/session-reader";
import { directPrompt } from "@/lib/llm-direct";
import { parseAutoName } from "@/lib/parse-auto-name";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/sessions/auto-name");

const SYSTEM_PROMPT = `你是一个会话标题生成助手。根据用户的第一条消息,生成一个 4-12 字的中文标题,精准概括用户的核心意图。

要求:
1. 只输出标题本身,不要任何解释、标点、引号、换行
2. 避免使用"用户询问"、"帮助"、"完成"、"测试"等空泛词
3. 如果消息内容不足以判断主题,直接返回: null

示例:
- "帮我看看这个 Python 报错" → Python 报错排查
- "我想做一个 todo 应用,带截止日期" → Todo 应用开发
- "hi" → null`;

// Extract plain text from a message entry. Mirrors the helper in
// lib/session-reader.ts but is local so the route stays self-contained.
function extractFirstUserText(entries: unknown[]): string | null {
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const entry = e as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (entry.type !== "message") continue;
    if (entry.message?.role !== "user") continue;
    const content = entry.message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = (content as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(" ")
        .trim();
      if (text) return text;
    }
    return null;
  }
  return null;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const startedAt = Date.now();
  log.debug("auto-name requested", { id });

  let filePath: string | null = null;
  try {
    filePath = await resolveSessionPath(id);
  } catch (err) {
    log.warn("auto-name resolve failed", { id, error: String(err), durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ skipped: "resolve_failed" });
  }
  if (!filePath) {
    log.warn("auto-name session not found", { id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ skipped: "not_found" });
  }

  let sm: ReturnType<typeof SessionManager.open>;
  try {
    sm = SessionManager.open(filePath);
  } catch (err) {
    log.warn("auto-name open failed", { id, error: String(err), durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ skipped: "open_failed" });
  }

  // Skip if the user already named this session.
  if (sm.getSessionName()) {
    log.info("auto-name skipped (already named)", { id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ skipped: "already_named" });
  }

  // Snapshot the first user message BEFORE calling the LLM. The race we're
  // guarding against: the user manually renames the session while the LLM
  // is running. We re-check the name right before writing below.
  const firstUserText = extractFirstUserText(sm.getEntries() as unknown[]);
  if (!firstUserText || firstUserText.trim().length === 0) {
    log.info("auto-name skipped (no first user message)", { id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ skipped: "no_first_message" });
  }

  let rawResponse: string;
  try {
    rawResponse = await directPrompt(firstUserText, {
      systemPrompt: SYSTEM_PROMPT,
      thinkingLevel: "off",
      timeoutMs: 50_000,
    });
  } catch (err) {
    log.warn("auto-name llm call failed", { id, error: String(err), durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ skipped: "llm_failed" });
  }

  const parsed = parseAutoName(rawResponse);
  if (!parsed) {
    log.info("auto-name parsed to null", { id, raw: rawResponse.slice(0, 80), durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ skipped: "parse_failed" });
  }

  // Re-check the name right before writing — the user may have manually
  // renamed the session during the LLM call (up to 50s window). Never
  // overwrite a user-defined name.
  if (sm.getSessionName()) {
    log.info("auto-name skipped (named during llm call)", { id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ skipped: "already_named" });
  }

  try {
    sm.appendSessionInfo(parsed);
    invalidateSessionListCache();
  } catch (err) {
    log.warn("auto-name append failed", { id, error: String(err), durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ skipped: "write_failed" });
  }

  log.info("auto-name applied", { id, name: parsed, durationMs: elapsedMs(startedAt) });
  return NextResponse.json({ name: parsed });
}
