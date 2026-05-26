import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createLogger, elapsedMs } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createLogger("api/models-config");

function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

function readModelsJson(): Record<string, unknown> {
  const path = getModelsPath();
  if (!existsSync(path)) return { providers: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { providers: {} };
  }
}

function writeModelsJson(data: Record<string, unknown>): void {
  const path = getModelsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

export async function GET() {
  const startedAt = Date.now();
  try {
    const data = readModelsJson();
    const providers = data.providers && typeof data.providers === "object"
      ? Object.keys(data.providers as Record<string, unknown>).length
      : 0;
    log.info("models config read", {
      path: getModelsPath(),
      providers,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(data);
  } catch (error) {
    log.error("models config read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const startedAt = Date.now();
  try {
    const body = await req.json() as Record<string, unknown>;
    writeModelsJson(body);
    // Model registry refreshes on each /api/models request (no local cache to invalidate)
    const providers = body.providers && typeof body.providers === "object"
      ? Object.keys(body.providers as Record<string, unknown>).length
      : 0;
    log.info("models config written", {
      path: getModelsPath(),
      providers,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error("models config write failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
