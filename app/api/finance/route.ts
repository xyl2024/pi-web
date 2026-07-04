import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import {
  createTransaction,
  listTransactions,
  type ListTransactionsOptions,
} from "@/lib/finance-store";
import {
  FinanceNotFoundError,
  FinanceValidationError,
  type CreateTransactionInput,
} from "@/lib/finance-schema";

const log = createLogger("api/finance");

function validationResponse(err: FinanceValidationError) {
  return NextResponse.json({ error: err.message }, { status: 400 });
}

// GET /api/finance?startMs=&endMs=&category=&noteSearch=
export async function GET(req: Request) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const opts: ListTransactionsOptions = {};
    const start = url.searchParams.get("startMs");
    const end = url.searchParams.get("endMs");
    const category = url.searchParams.get("category");
    const noteSearch = url.searchParams.get("detailsSearch");
    if (start) {
      const n = Number(start);
      if (!Number.isFinite(n)) {
        return NextResponse.json(
          { error: "startMs must be a finite number" },
          { status: 400 },
        );
      }
      opts.startMs = n;
    }
    if (end) {
      const n = Number(end);
      if (!Number.isFinite(n)) {
        return NextResponse.json(
          { error: "endMs must be a finite number" },
          { status: 400 },
        );
      }
      opts.endMs = n;
    }
    if (category && category.length > 0) opts.category = category;
    if (noteSearch && noteSearch.length > 0) opts.detailsSearch = noteSearch;

    const transactions = listTransactions(opts);
    log.info("finance list", {
      count: transactions.length,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ transactions });
  } catch (error) {
    if (error instanceof FinanceValidationError) return validationResponse(error);
    log.error("finance list failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/finance  body: CreateTransactionInput
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const input: CreateTransactionInput = {
      date: body.date as number,
      amount: body.amount as number,
      direction: body.direction as CreateTransactionInput["direction"],
      category: body.category as string,
      details: (body.details as string | undefined) ?? "",
    };
    const result = createTransaction(input);
    log.info("finance created", {
      id: result.transaction.id,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FinanceValidationError) return validationResponse(error);
    if (error instanceof FinanceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("finance create failed", {
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}