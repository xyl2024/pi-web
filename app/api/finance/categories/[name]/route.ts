import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { deleteCategory } from "@/lib/finance-store";
import {
  FinanceNotFoundError,
  FinanceValidationError,
} from "@/lib/finance-schema";

const log = createLogger("api/finance/categories/[name]");

function validationResponse(err: FinanceValidationError) {
  return NextResponse.json({ error: err.message }, { status: 400 });
}

// DELETE /api/finance/categories/[name]
// Removes the category from the categories table. Existing transactions
// keep their (now-orphaned) category string — they are historical fact.
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const startedAt = Date.now();
  try {
    const { name } = await ctx.params;
    const result = deleteCategory(decodeURIComponent(name));
    log.info("finance category deleted", {
      name: result.name,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FinanceValidationError) return validationResponse(error);
    if (error instanceof FinanceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("finance category delete failed", {
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}