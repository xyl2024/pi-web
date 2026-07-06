/**
 * Public types, validation helpers, and error classes for the daily-accounting
 * (FinancePanel) feature. Storage lives in `lib/finance-store.ts` and the
 * schema is declared in `lib/finance-db.ts`; this file is the contract
 * between storage and the API routes / React layer.
 *
 * Phase 1 covers expense + income only. Asset allocation (Phase 2) will land
 * in a separate `holdings` table; this file deliberately does NOT reserve any
 * fields for that future work.
 *
 * Categories are weakly referenced (categories table for CRUD UI; the
 * transactions.category column is still free-text). This keeps the schema
 * minimal and lets a transaction outlive its category if the user deletes it.
 */

export type FinanceDirection = "income" | "expense";

export interface Transaction {
  id: string;
  /** Epoch ms of the day the transaction happened. */
  date: number;
  /** Positive amount in yuan. Direction is tracked separately. */
  amount: number;
  direction: FinanceDirection;
  /** Free-text category. Case-sensitive; no normalization. */
  category: string;
  /** Required free-text description of what this transaction is. */
  details: string;
  /** Server-stamped epoch ms. */
  createdAt: number;
}

export interface Category {
  /** Display name. Unique (case-sensitive). */
  name: string;
  /** Server-stamped epoch ms. */
  createdAt: number;
}

export interface CreateTransactionInput {
  date: number;
  amount: number;
  direction: FinanceDirection;
  /**
   * Optional. When the details string contains a `#<preset>` token the
   * server derives the category from there (see `parseCategoryFromDetails`
   * in `lib/finance-preset-categories.ts`); otherwise this field is used as
   * a fallback. At least one source must yield a valid preset name.
   */
  category?: string;
  details: string;
}

export interface UpdateTransactionInput {
  date?: number;
  amount?: number;
  direction?: FinanceDirection;
  category?: string;
  details?: string;
}

export interface ListTransactionsResponse {
  transactions: Transaction[];
}

export interface ByCategoryRow {
  category: string;
  total: number;
  direction: FinanceDirection;
}

export interface FinanceStatsResponse {
  month: { year: number; month: number };
  totalIncome: number;
  totalExpense: number;
  net: number;
  count: number;
  byCategory: ByCategoryRow[];
}

export interface CreateTransactionResult {
  transaction: Transaction;
}

export class FinanceValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "FinanceValidationError";
  }
}

export class FinanceNotFoundError extends Error {
  public readonly id: string;
  constructor(kind: "transaction" | "category", id: string) {
    super(`${kind} not found`);
    this.name = "FinanceNotFoundError";
    this.id = id;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FINANCE_DIRECTIONS: FinanceDirection[] = ["income", "expense"];

export const MAX_CATEGORY_LENGTH = 50;
export const MAX_DETAILS_LENGTH = 500;
export const MIN_AMOUNT = 0.001;
export const MAX_AMOUNT = 1_000_000_000; // 1B yuan — sanity cap

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validateDirection(
  value: unknown,
  field: string = "direction",
): FinanceDirection {
  if (typeof value !== "string") {
    throw new FinanceValidationError(`${field} must be a string`, field);
  }
  if (value !== "income" && value !== "expense") {
    throw new FinanceValidationError(
      `${field} must be one of: income, expense`,
      field,
    );
  }
  return value;
}

export function validateAmount(
  value: unknown,
  field: string = "amount",
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FinanceValidationError(`${field} must be a finite number`, field);
  }
  if (value < MIN_AMOUNT || value > MAX_AMOUNT) {
    throw new FinanceValidationError(
      `${field} must be between ${MIN_AMOUNT} and ${MAX_AMOUNT}`,
      field,
    );
  }
  return value;
}

export function validateCategory(
  value: unknown,
  field: string = "category",
): string {
  if (typeof value !== "string") {
    throw new FinanceValidationError(`${field} must be a string`, field);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new FinanceValidationError(`${field} cannot be empty`, field);
  }
  if (trimmed.length > MAX_CATEGORY_LENGTH) {
    throw new FinanceValidationError(`${field} is too long`, field);
  }
  return trimmed;
}

export function validateDetails(
  value: unknown,
  field: string = "details",
): string {
  if (typeof value !== "string") {
    throw new FinanceValidationError(`${field} must be a string`, field);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new FinanceValidationError(`${field} cannot be empty`, field);
  }
  if (trimmed.length > MAX_DETAILS_LENGTH) {
    throw new FinanceValidationError(`${field} is too long`, field);
  }
  return trimmed;
}

export function validateDateMs(
  value: unknown,
  field: string = "date",
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FinanceValidationError(`${field} must be a finite number`, field);
  }
  if (value < 0) {
    throw new FinanceValidationError(`${field} must be non-negative`, field);
  }
  // Reject obviously bogus timestamps (year > 9999)
  if (value > 253_402_300_799_000) {
    throw new FinanceValidationError(`${field} is too large`, field);
  }
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Month arithmetic — pure function, shared by client + server
// ---------------------------------------------------------------------------

/**
 * Returns the half-open [startMs, endMs) window for a (year, month1to12) pair
 * in UTC. The caller is expected to pass the user's local year/month; the
 * server accepts the bounds verbatim and SQL filters by `date BETWEEN ?`.
 */
export function monthBounds(
  year: number,
  month1to12: number,
): { startMs: number; endMs: number } {
  if (!Number.isInteger(year) || !Number.isInteger(month1to12)) {
    throw new FinanceValidationError(
      "year and month must be integers",
      "month",
    );
  }
  if (month1to12 < 1 || month1to12 > 12) {
    throw new FinanceValidationError("month must be between 1 and 12", "month");
  }
  const startMs = Date.UTC(year, month1to12 - 1, 1, 0, 0, 0, 0);
  const endMs = Date.UTC(year, month1to12, 1, 0, 0, 0, 0);
  return { startMs, endMs };
}

// ---------------------------------------------------------------------------
// ID generation — mirror of http-collections-schema.ts:319
// ---------------------------------------------------------------------------

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}