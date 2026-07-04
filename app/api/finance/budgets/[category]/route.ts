import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { deleteBudget } from "@/lib/finance-store";
import { FinanceNotFoundError, FinanceValidationError } from "@/lib/finance-schema";

const log = createLogger("api/finance/budgets/[category]");

function validationResponse(err: FinanceValidationError) {
  return NextResponse.json({ error: err.message }, { status: 400 });
}

// DELETE /api/finance/budgets/[category]
export async function DELETE(_req: Request, ctx: { params: Promise<{ category: string }> }) {
  const startedAt = Date.now();
  try {
    const { category } = await ctx.params;
    const result = deleteBudget(decodeURIComponent(category));
    log.info("finance budget deleted", {
      category: result.category,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FinanceValidationError) return validationResponse(error);
    if (error instanceof FinanceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("finance budget delete failed", {
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}