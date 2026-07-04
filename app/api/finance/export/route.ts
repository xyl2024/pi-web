import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { listTransactions } from "@/lib/finance-store";

const log = createLogger("api/finance/export");

/**
 * CSV-escape a single field per RFC 4180. Wraps in double quotes if the
 * field contains a comma, quote, newline, or carriage return; doubles any
 * embedded quotes.
 */
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// GET /api/finance/export — download all transactions as CSV (UTF-8 with BOM)
export async function GET() {
  const startedAt = Date.now();
  try {
    const transactions = listTransactions();
    // CSV is ordered by created_at ASC for stable diffs.
    const rows: string[] = [];
    rows.push(
      ["id", "date", "amount", "direction", "category", "details"].join(","),
    );
    for (const t of transactions) {
      rows.push(
        [
          csvEscape(t.id),
          csvEscape(isoDate(new Date(t.date))),
          csvEscape(String(t.amount)),
          csvEscape(t.direction),
          csvEscape(t.category),
          csvEscape(t.details),
        ].join(","),
      );
    }
    const body = "﻿" + rows.join("\r\n") + "\r\n";
    const filename = `finance-${isoDate(new Date())}.csv`;
    log.info("finance export", {
      count: transactions.length,
      durationMs: elapsedMs(startedAt),
    });
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    log.error("finance export failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}