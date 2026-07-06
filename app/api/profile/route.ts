import { NextResponse } from "next/server";
import { readProfile, writeProfile } from "@/lib/profile-store";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/profile");

export const dynamic = "force-dynamic";

// GET /api/profile  →  { username: string | null }
export async function GET() {
  const startedAt = Date.now();
  try {
    const profile = readProfile();
    log.info("profile read", { durationMs: elapsedMs(startedAt) });
    return NextResponse.json(profile);
  } catch (error) {
    log.error("profile read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PUT /api/profile  body: { username: string | null }
export async function PUT(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json()) as { username?: unknown };
    if (body.username !== null && body.username !== undefined && typeof body.username !== "string") {
      return NextResponse.json({ error: "username must be a string or null" }, { status: 400 });
    }
    const profile = writeProfile({ username: typeof body.username === "string" ? body.username : null });
    log.info("profile written", { durationMs: elapsedMs(startedAt) });
    return NextResponse.json(profile);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const status = msg.includes("too long") ? 400 : 500;
    log.error("profile write failed", { error: msg, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: msg }, { status });
  }
}