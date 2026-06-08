import { NextResponse } from "next/server";
import { join } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";
import { readStringArray, writeStringArray } from "@/lib/json-array-store";

const log = createLogger("api/pinned-cwds");
const PINNED_FILE = join(homedir(), ".pi-web", "pinned.json");

// GET /api/pinned-cwds
export async function GET() {
  const startedAt = Date.now();
  try {
    const cwds = readStringArray(PINNED_FILE);
    log.info("pinned cwds read", { count: cwds.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ cwds });
  } catch (error) {
    log.error("pinned cwds read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PUT /api/pinned-cwds
export async function PUT(req: Request) {
  const startedAt = Date.now();
  try {
    const body = await req.json() as { cwds?: unknown };
    if (!Array.isArray(body.cwds) || !body.cwds.every((v) => typeof v === "string")) {
      return NextResponse.json({ error: "cwds must be an array of strings" }, { status: 400 });
    }
    const cwds = body.cwds as string[];
    writeStringArray(PINNED_FILE, cwds);
    log.info("pinned cwds written", { count: cwds.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ cwds });
  } catch (error) {
    log.error("pinned cwds write failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
