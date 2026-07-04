import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import {
  createCategory,
  distinctCategoriesWithCounts,
  getAllCategories,
  renameCategory,
} from "@/lib/finance-store";
import {
  FinanceNotFoundError,
  FinanceValidationError,
} from "@/lib/finance-schema";

const log = createLogger("api/finance/categories");

function validationResponse(err: FinanceValidationError) {
  return NextResponse.json({ error: err.message }, { status: 400 });
}

interface CategoryWithCount {
  name: string;
  count: number;
  createdAt: number;
}

// GET /api/finance/categories
// Returns the registered categories plus a count of how many transactions
// use each one. Categories with zero transactions are still listed (they
// appear when the user has manually created one for future use).
export async function GET() {
  const startedAt = Date.now();
  try {
    const registered = getAllCategories();
    const usage = distinctCategoriesWithCounts();
    const usageMap = new Map(usage.map((u) => [u.category, u.count]));

    const merged: CategoryWithCount[] = [
      ...registered.map((c) => ({
        name: c.name,
        count: usageMap.get(c.name) ?? 0,
        createdAt: c.createdAt,
      })),
      // Surface any category used in transactions but missing from the
      // registered list (legacy data + edge cases).
      ...usage
        .filter((u) => !registered.some((r) => r.name === u.category))
        .map((u) => ({
          name: u.category,
          count: u.count,
          createdAt: 0,
        })),
    ];
    merged.sort((a, b) => a.name.localeCompare(b.name));

    log.info("finance categories read", {
      count: merged.length,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ categories: merged });
  } catch (error) {
    log.error("finance categories read failed", {
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/finance/categories  body: { name: string }
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const category = createCategory(body.name as string);
    log.info("finance category created", {
      name: category.name,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ category });
  } catch (error) {
    if (error instanceof FinanceValidationError) return validationResponse(error);
    log.error("finance category create failed", {
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/finance/categories  body: { oldName: string; newName: string }
// Renames a category across transactions + budgets atomically.
export async function PATCH(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = renameCategory(
      body.oldName as string,
      body.newName as string,
    );
    log.info("finance category renamed", {
      oldName: result.oldName,
      newName: result.newName,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FinanceValidationError) return validationResponse(error);
    if (error instanceof FinanceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error("finance category rename failed", {
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}