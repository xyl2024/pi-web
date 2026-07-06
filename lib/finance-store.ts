/**
 * SQLite-backed CRUD + aggregation for the daily-accounting (FinancePanel)
 * feature. See plan: `tab-grill-me-in-chinese-sorted-moth.md`.
 *
 * Mirror of `lib/http-collections-store.ts`: validation, custom error classes,
 * row-to-type mappers, and `db.transaction(() => { ... })()` blocks for
 * mutating ops.
 *
 * All reads go through the singleton DB handle in `lib/finance-db.ts`. No
 * in-memory cache; freshness is the React layer's job (see
 * `hooks/useFinance.ts`).
 */

import { getFinanceDb } from "@/lib/finance-db";
import { parseCategoryFromDetails, validatePresetCategory } from "@/lib/finance-preset-categories";
import {
  type Budget,
  type ByCategoryRow,
  type CreateTransactionInput,
  type CreateTransactionResult,
  type FinanceDirection,
  type FinanceStatsResponse,
  type Transaction,
  type UpdateTransactionInput,
  FinanceNotFoundError,
  FinanceValidationError,
  generateId,
  monthBounds,
  validateAmount,
  validateDateMs,
  validateDetails,
  validateDirection,
  validateMonthlyLimit,
} from "@/lib/finance-schema";

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface TransactionRow {
  id: string;
  date: number;
  amount: number;
  direction: string;
  category: string;
  details: string;
  created_at: number;
}

interface BudgetRow {
  category: string;
  monthly_limit: number;
  updated_at: number;
}

function rowToTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    date: row.date,
    amount: row.amount,
    direction: row.direction as FinanceDirection,
    category: row.category,
    details: row.details,
    createdAt: row.created_at,
  };
}

function rowToBudget(row: BudgetRow): Budget {
  return {
    category: row.category,
    monthlyLimit: row.monthly_limit,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Transaction CRUD
// ---------------------------------------------------------------------------

export function createTransaction(
  input: CreateTransactionInput,
): CreateTransactionResult {
  const date = validateDateMs(input.date, "date");
  const amount = validateAmount(input.amount, "amount");
  const direction = validateDirection(input.direction, "direction");
  // Category resolution: a `#<preset>` token inside `details` is the
  // preferred source (UI inserts it via the picker); otherwise fall back to
  // `input.category`. At least one source must yield a valid preset name —
  // missing both produces a 400 "category required" error.
  const parsed = parseCategoryFromDetails(input.details);
  const cleanDetails = validateDetails(parsed.cleanDetails, "details");
  const category =
    parsed.category ??
    (input.category !== undefined && input.category.length > 0
      ? validatePresetCategory(input.category, "category")
      : (() => {
          throw new FinanceValidationError(
            "category is required (type # in details to pick one)",
            "category",
          );
        })());

  const id = generateId();
  const now = Date.now();
  const db = getFinanceDb();

  const apply = db.transaction(() => {
    db.prepare(
      `INSERT INTO transactions (id, date, amount, direction, category, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, date, amount, direction, category, cleanDetails, now);
  });
  apply();

  const transaction: Transaction = {
    id,
    date,
    amount,
    direction,
    category,
    details: cleanDetails,
    createdAt: now,
  };

  // Only expense transactions can push a budget over its limit.
  const budgetWarning =
    direction === "expense"
      ? checkBudgetWarning(category, date)
      : undefined;

  return { transaction, budgetWarning };
}

export function updateTransaction(
  id: string,
  patch: UpdateTransactionInput,
): CreateTransactionResult {
  if (typeof id !== "string" || id.length === 0) {
    throw new FinanceNotFoundError("transaction", String(id));
  }
  const db = getFinanceDb();
  const apply = db.transaction((): Transaction => {
    const row = db
      .prepare(`SELECT * FROM transactions WHERE id = ?`)
      .get(id) as TransactionRow | undefined;
    if (!row) throw new FinanceNotFoundError("transaction", id);
    const next = rowToTransaction(row);
    if (patch.date !== undefined) {
      next.date = validateDateMs(patch.date, "date");
    }
    if (patch.amount !== undefined) {
      next.amount = validateAmount(patch.amount, "amount");
    }
    if (patch.direction !== undefined) {
      next.direction = validateDirection(patch.direction, "direction");
    }
    if (patch.details !== undefined) {
      // Re-parse the new details for an embedded `#<preset>` token; it takes
      // precedence over `patch.category` (the UI inserts the token via the
      // picker so it's the more recent intent). Strip the token from the
      // stored details either way.
      const parsed = parseCategoryFromDetails(patch.details);
      next.details = validateDetails(parsed.cleanDetails, "details");
      if (parsed.category !== null) {
        next.category = parsed.category;
      } else if (patch.category !== undefined) {
        next.category = validatePresetCategory(patch.category, "category");
      } else {
        // Keep the existing category.
      }
    } else if (patch.category !== undefined) {
      next.category = validatePresetCategory(patch.category, "category");
    }
    db.prepare(
      `UPDATE transactions
         SET date = ?, amount = ?, direction = ?, category = ?, details = ?
       WHERE id = ?`,
    ).run(next.date, next.amount, next.direction, next.category, next.details, id);
    return next;
  });
  const result = apply();

  // Only expense edits can trigger a budget warning. Use the post-update row.
  const budgetWarning =
    result.direction === "expense"
      ? checkBudgetWarning(result.category, result.date)
      : undefined;
  return { transaction: result, budgetWarning };
}

export function deleteTransaction(id: string): { id: string } {
  if (typeof id !== "string" || id.length === 0) {
    throw new FinanceNotFoundError("transaction", String(id));
  }
  const db = getFinanceDb();
  const result = db.prepare(`DELETE FROM transactions WHERE id = ?`).run(id);
  if (result.changes === 0) throw new FinanceNotFoundError("transaction", id);
  return { id };
}

export function getTransactionById(id: string): Transaction | undefined {
  if (typeof id !== "string" || id.length === 0) return undefined;
  const row = getFinanceDb()
    .prepare(`SELECT * FROM transactions WHERE id = ?`)
    .get(id) as TransactionRow | undefined;
  return row ? rowToTransaction(row) : undefined;
}

export interface ListTransactionsOptions {
  startMs?: number;
  endMs?: number;
  category?: string;
  detailsSearch?: string;
}

export function listTransactions(
  opts: ListTransactionsOptions = {},
): Transaction[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.startMs !== undefined) {
    where.push(`date >= ?`);
    params.push(opts.startMs);
  }
  if (opts.endMs !== undefined) {
    where.push(`date < ?`);
    params.push(opts.endMs);
  }
  if (opts.category !== undefined && opts.category.length > 0) {
    where.push(`category = ?`);
    params.push(opts.category);
  }
  if (opts.detailsSearch !== undefined && opts.detailsSearch.length > 0) {
    // SQLite LIKE is case-insensitive for ASCII by default; Chinese
    // characters are matched byte-for-byte which is also what users expect.
    where.push(`details LIKE ?`);
    params.push(`%${opts.detailsSearch}%`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getFinanceDb()
    .prepare(
      `SELECT * FROM transactions ${whereClause} ORDER BY date DESC, created_at DESC`,
    )
    .all(...params) as TransactionRow[];
  return rows.map(rowToTransaction);
}

// ---------------------------------------------------------------------------
// Aggregation — single SQL for the monthly stats card
// ---------------------------------------------------------------------------

/**
 * Compute income/expense totals, count, and per-category breakdown for a
 * single calendar month. Uses one SQL with LEFT JOIN to `budgets` so the
 * budget card has everything it needs without a second round-trip.
 */
export function computeMonthStats(
  year: number,
  month1to12: number,
): FinanceStatsResponse {
  const { startMs, endMs } = monthBounds(year, month1to12);
  const db = getFinanceDb();

  type AggRow = {
    direction: FinanceDirection;
    category: string;
    total: number;
    monthly_limit: number | null;
  };

  const aggRows = db
    .prepare(
      `SELECT t.direction, t.category, SUM(t.amount) AS total, b.monthly_limit
         FROM transactions t
         LEFT JOIN budgets b ON b.category = t.category
        WHERE t.date >= ? AND t.date < ?
        GROUP BY t.direction, t.category`,
    )
    .all(startMs, endMs) as AggRow[];

  let totalIncome = 0;
  let totalExpense = 0;
  let count = 0;
  const byCategory: ByCategoryRow[] = [];

  for (const r of aggRows) {
    if (r.direction === "income") {
      totalIncome += r.total;
    } else {
      totalExpense += r.total;
    }
    byCategory.push({
      category: r.category,
      total: r.total,
      direction: r.direction,
      ...(r.monthly_limit !== null ? { budgetLimit: r.monthly_limit } : {}),
    });
  }

  // Count rows separately (the GROUP BY above doesn't expose it directly).
  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM transactions WHERE date >= ? AND date < ?`,
    )
    .get(startMs, endMs) as { c: number };
  count = countRow.c;

  return {
    month: { year, month: month1to12 },
    totalIncome,
    totalExpense,
    net: totalIncome - totalExpense,
    count,
    byCategory,
  };
}

// ---------------------------------------------------------------------------
// Categories — preset list only (see `lib/finance-preset-categories.ts`). The
// only categories-related helper here is the per-transaction count view,
// used by clients that want to show usage stats.
// ---------------------------------------------------------------------------

/**
 * Distinct categories that appear in `transactions`, with counts. Includes
 * any legacy free-text categories from before the preset migration so they
 * remain visible in historical aggregation (the preset list itself comes
 * from `lib/finance-preset-categories.ts`). Sorted by frequency desc.
 */
export function distinctCategoriesWithCounts(): Array<{
  category: string;
  count: number;
}> {
  const db = getFinanceDb();
  const rows = db
    .prepare(
      `SELECT category, COUNT(*) AS c
         FROM transactions
        GROUP BY category
        ORDER BY c DESC, category ASC`,
    )
    .all() as Array<{ category: string; c: number }>;
  return rows.map((r) => ({ category: r.category, count: r.c }));
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export function getAllBudgets(): Budget[] {
  const rows = getFinanceDb()
    .prepare(`SELECT * FROM budgets ORDER BY category ASC`)
    .all() as BudgetRow[];
  return rows.map(rowToBudget);
}

export function upsertBudget(
  rawCategory: string,
  rawLimit: unknown,
): Budget {
  const category = validatePresetCategory(rawCategory, "category");
  const monthlyLimit = validateMonthlyLimit(rawLimit, "monthlyLimit");
  const now = Date.now();
  const db = getFinanceDb();
  db.prepare(
    `INSERT INTO budgets (category, monthly_limit, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(category) DO UPDATE SET
       monthly_limit = excluded.monthly_limit,
       updated_at = excluded.updated_at`,
  ).run(category, monthlyLimit, now);
  return { category, monthlyLimit, updatedAt: now };
}

export function deleteBudget(category: string): { category: string } {
  const validated = validatePresetCategory(category, "category");
  const db = getFinanceDb();
  const result = db
    .prepare(`DELETE FROM budgets WHERE category = ?`)
    .run(validated);
  if (result.changes === 0) throw new FinanceNotFoundError("budget", validated);
  return { category: validated };
}

// ---------------------------------------------------------------------------
// Budget-warning check — used after every expense write so the route can
// include a warning payload in its response, and the client fires a toast.
// ---------------------------------------------------------------------------

function checkBudgetWarning(
  category: string,
  dateMs: number,
): CreateTransactionResult["budgetWarning"] | undefined {
  const budget = getFinanceDb()
    .prepare(`SELECT monthly_limit FROM budgets WHERE category = ?`)
    .get(category) as { monthly_limit: number } | undefined;
  if (!budget) return undefined;

  const d = new Date(dateMs);
  const spent = sumExpenseForMonth(category, d.getUTCFullYear(), d.getUTCMonth() + 1);
  if (spent > budget.monthly_limit) {
    return {
      category,
      monthlyLimit: budget.monthly_limit,
      spent,
    };
  }
  return undefined;
}

function sumExpenseForMonth(
  category: string,
  year: number,
  month1to12: number,
): number {
  const { startMs, endMs } = monthBounds(year, month1to12);
  const row = getFinanceDb()
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS s
         FROM transactions
        WHERE category = ?
          AND direction = 'expense'
          AND date >= ? AND date < ?`,
    )
    .get(category, startMs, endMs) as { s: number };
  return row.s;
}