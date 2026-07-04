import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { getAllBudgets, upsertBudget } from "@/lib/finance-store";
import { FinanceNotFoundError, FinanceValidationError } from "@/lib/finance-schema";

const log = createLogger("api/finance/budgets");

function validationResponse(err: FinanceValidationError) {
  return NextResponse.json({ error: err.message }, { status: 400 });
}

// GET /api/finance/budgets
export async function GET() {
  const startedAt = Date.now();
  try {
    const budgets = getAllBudgets();
    log.info("finance budgets read", {
      count: budgets.length,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ budgets });
  } catch (error) {
    log.error("finance budgets read failed", {
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PUT /api/finance/budgets  body: { category: string; monthlyLimit: number }
export async function PUT(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const budget = upsertBudget(body.category as string, body.monthlyLimit);
    log.info("finance budget upserted", {
      category: budget.category,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ budget });
  } catch (error) {
    if (error instanceof FinanceValidationError) return validationResponse(error);
    if (error instanceof FinanceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("finance budget upsert failed", {
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}