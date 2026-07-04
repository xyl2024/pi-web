import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { computeMonthStats } from "@/lib/finance-store";
import { monthBounds } from "@/lib/finance-schema";

const log = createLogger("api/finance/stats");

// GET /api/finance/stats?year=YYYY&month=1-12
// Uses UTC bounds via monthBounds() — caller passes the user's local year/month.
export async function GET(req: Request) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const yearStr = url.searchParams.get("year");
    const monthStr = url.searchParams.get("month");
    if (!yearStr || !monthStr) {
      return NextResponse.json(
        { error: "year and month query params are required" },
        { status: 400 },
      );
    }
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
      return NextResponse.json(
        { error: "year and month must be integers" },
        { status: 400 },
      );
    }
    // monthBounds throws on invalid month — caught here to map to 400.
    monthBounds(year, month);
    const stats = computeMonthStats(year, month);
    log.info("finance stats", {
      year,
      month,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(stats);
  } catch (error) {
    if (error instanceof Error && error.message.includes("month")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    log.error("finance stats failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}