import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/default-cwd");

// POST /api/default-cwd
// Creates ~/pi-cwd-<YYYYMMDD> if it doesn't exist and returns the path.
export async function POST() {
  const startedAt = Date.now();
  try {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dir = join(homedir(), `pi-cwd-${date}`);
    mkdirSync(dir, { recursive: true });
    log.info("default cwd created", { cwd: dir, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    log.error("default cwd create failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
