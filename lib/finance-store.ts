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
  type CreateTransactionInput,
  type CreateTransactionResult,
  type FinanceDirection,
  type Transaction,
  type UpdateTransactionInput,
  FinanceNotFoundError,
  FinanceValidationError,
  generateId,
  validateAmount,
  validateDateMs,
  validateDetails,
  validateDirection,
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

  return { transaction };
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

  return { transaction: result };
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