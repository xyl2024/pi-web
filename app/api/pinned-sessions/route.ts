import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/pinned-sessions");
const PINNED_FILE = join(homedir(), ".pi-web", "pinned-sessions.json");

function readPinned(): string[] {
  try {
    const raw = readFileSync(PINNED_FILE, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (Array.isArray(data) && data.every((v) => typeof v === "string")) {
      return data as string[];
    }
    return [];
  } catch {
    return [];
  }
}

function writePinned(sessionIds: string[]): void {
  mkdirSync(dirname(PINNED_FILE), { recursive: true });
  writeFileSync(PINNED_FILE, JSON.stringify(sessionIds, null, 2), "utf-8");
}

// GET /api/pinned-sessions
export async function GET() {
  const startedAt = Date.now();
  try {
    const sessionIds = readPinned();
    log.info("pinned sessions read", { count: sessionIds.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ sessionIds });
  } catch (error) {
    log.error("pinned sessions read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PUT /api/pinned-sessions
export async function PUT(req: Request) {
  const startedAt = Date.now();
  try {
    const body = await req.json() as { sessionIds?: unknown };
    if (!Array.isArray(body.sessionIds)) {
      return NextResponse.json({ error: "sessionIds must be an array" }, { status: 400 });
    }
    if (!body.sessionIds.every((v) => typeof v === "string")) {
      return NextResponse.json({ error: "sessionIds must be an array of strings" }, { status: 400 });
    }
    writePinned(body.sessionIds as string[]);
    log.info("pinned sessions written", { count: body.sessionIds.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ sessionIds: body.sessionIds });
  } catch (error) {
    log.error("pinned sessions write failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
