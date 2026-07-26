import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createLogger, elapsedMs } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createLogger("api/append-system");

function getAppendSystemPath(): string {
  return join(getAgentDir(), "APPEND_SYSTEM.md");
}

// GET /api/append-system — read ~/.pi/agent/APPEND_SYSTEM.md
export async function GET() {
  const startedAt = Date.now();
  const path = getAppendSystemPath();
  try {
    if (!existsSync(path)) {
      log.info("append system file not found", { path, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ content: "", exists: false, path });
    }
    const content = await readFile(path, "utf8");
    log.info("append system read", { path, bytes: content.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ content, exists: true, path });
  } catch (error) {
    log.error("append system read failed", { path, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PUT /api/append-system — write ~/.pi/agent/APPEND_SYSTEM.md
export async function PUT(req: Request) {
  const startedAt = Date.now();
  const path = getAppendSystemPath();
  try {
    const body = (await req.json()) as { content?: unknown };
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content must be a string" }, { status: 400 });
    }
    const content = body.content;
    // Always end with a newline so subsequent appends (e.g. `cat >>`) stay clean.
    const normalized = content.endsWith("\n") ? content : `${content}\n`;
    await writeFile(path, normalized, "utf8");
    log.info("append system written", { path, bytes: normalized.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ success: true, path });
  } catch (error) {
    log.error("append system write failed", { path, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}