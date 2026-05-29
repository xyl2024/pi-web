import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/pinned-cwds");
const PINNED_FILE = join(homedir(), ".pi-web", "pinned.json");

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

function writePinned(cwds: string[]): void {
  mkdirSync(dirname(PINNED_FILE), { recursive: true });
  writeFileSync(PINNED_FILE, JSON.stringify(cwds, null, 2), "utf-8");
}

// GET /api/pinned-cwds
export async function GET() {
  const startedAt = Date.now();
  try {
    const cwds = readPinned();
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
    if (!Array.isArray(body.cwds)) {
      return NextResponse.json({ error: "cwds must be an array" }, { status: 400 });
    }
    if (!body.cwds.every((v) => typeof v === "string")) {
      return NextResponse.json({ error: "cwds must be an array of strings" }, { status: 400 });
    }
    writePinned(body.cwds as string[]);
    log.info("pinned cwds written", { count: body.cwds.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ cwds: body.cwds });
  } catch (error) {
    log.error("pinned cwds write failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
