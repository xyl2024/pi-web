import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { listAll } from "@/lib/http-collections-store";

const log = createLogger("api/http-collections");

// GET /api/http-collections  — single full snapshot (Y1/Z1: no incremental fetches)
export async function GET() {
  const startedAt = Date.now();
  try {
    const data = listAll();
    log.info("http-collections read", {
      collections: data.collections.length,
      items: data.items.length,
      joinRows: data.joinRows.length,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(data);
  } catch (error) {
    log.error("http-collections read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
