import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import {
  deleteTransaction,
  getTransactionById,
  updateTransaction,
} from "@/lib/finance-store";
import {
  FinanceNotFoundError,
  FinanceValidationError,
  type UpdateTransactionInput,
} from "@/lib/finance-schema";

const log = createLogger("api/finance/[id]");

function validationResponse(err: FinanceValidationError) {
  return NextResponse.json({ error: err.message }, { status: 400 });
}

// GET /api/finance/[id]
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  try {
    const { id } = await ctx.params;
    const tx = getTransactionById(id);
    if (!tx) throw new FinanceNotFoundError("transaction", id);
    log.info("finance read", { id: tx.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ transaction: tx });
  } catch (error) {
    if (error instanceof FinanceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("finance read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/finance/[id]  body: UpdateTransactionInput
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: UpdateTransactionInput = {
      date: body.date as number | undefined,
      amount: body.amount as number | undefined,
      direction: body.direction as UpdateTransactionInput["direction"],
      category: body.category as string | undefined,
      details: body.details as string | undefined,
    };
    const result = updateTransaction(id, patch);
    log.info("finance updated", {
      id: result.transaction.id,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FinanceValidationError) return validationResponse(error);
    if (error instanceof FinanceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("finance update failed", {
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/finance/[id]
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  try {
    const { id } = await ctx.params;
    const result = deleteTransaction(id);
    log.info("finance deleted", { id: result.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FinanceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("finance delete failed", {
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}