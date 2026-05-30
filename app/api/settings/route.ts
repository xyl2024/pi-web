import { NextResponse } from "next/server";
import { readConfig, writeConfig, type PiWebConfig } from "@/lib/config";
import { createLogger, elapsedMs } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createLogger("api/settings");

export async function GET() {
  const startedAt = Date.now();
  try {
    const config = readConfig();
    log.info("settings read", { durationMs: elapsedMs(startedAt) });
    return NextResponse.json(config);
  } catch (error) {
    log.error("settings read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json()) as PiWebConfig;
    writeConfig(body);
    log.info("settings written", { durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error("settings write failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
