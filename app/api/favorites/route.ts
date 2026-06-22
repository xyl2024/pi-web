import { NextResponse } from "next/server";
import { join } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";
import { readStringArray, writeStringArray } from "@/lib/json-array-store";

const log = createLogger("api/favorites");
const FAVORITES_FILE = join(homedir(), ".pi-web", "favorites.json");

// GET /api/favorites
export async function GET() {
  const startedAt = Date.now();
  try {
    const sessionIds = readStringArray(FAVORITES_FILE);
    log.info("favorites read", { count: sessionIds.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ sessionIds });
  } catch (error) {
    log.error("favorites read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PUT /api/favorites
export async function PUT(req: Request) {
  const startedAt = Date.now();
  try {
    const body = await req.json() as { sessionIds?: unknown };
    if (!Array.isArray(body.sessionIds) || !body.sessionIds.every((v) => typeof v === "string")) {
      return NextResponse.json({ error: "sessionIds must be an array of strings" }, { status: 400 });
    }
    const sessionIds = body.sessionIds as string[];
    writeStringArray(FAVORITES_FILE, sessionIds);
    log.info("favorites written", { count: sessionIds.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ sessionIds });
  } catch (error) {
    log.error("favorites write failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}