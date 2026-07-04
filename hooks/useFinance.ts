"use client";

/**
 * Client-side hook for the daily-accounting (FinancePanel) feature.
 *
 * Data flow mirrors `useHttpCollections`: full-snapshot GET on mount
 * + window focus refetch. After every mutation the hook refetches so the UI
 * never sees stale data. No client-side cache; the SQLite file is the source
 * of truth and the React layer keeps a local copy.
 *
 * The monthly aggregation (income/expense/net/count) is derived client-side
 * from the full snapshot via useMemo. With typical personal-finance volumes
 * (a few hundred to a few thousand rows) the O(n) walk is negligible
 * compared to the network round-trip.
 *
 * Errors are surfaced as toasts by the call sites; the hook itself just
 * returns the latest `Error` and lets the caller decide.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Budget,
  Category,
  CreateTransactionInput,
  FinanceDirection,
  FinanceStatsResponse,
  Transaction,
  UpdateTransactionInput,
} from "@/lib/finance-schema";

interface CreateTransactionResult {
  transaction: Transaction;
  budgetWarning?: { category: string; monthlyLimit: number; spent: number };
}

export interface CategoryWithCount {
  name: string;
  count: number;
  createdAt: number;
}

export interface UseFinanceState {
  transactions: Transaction[];
  budgets: Budget[];
  categories: CategoryWithCount[];
  isLoading: boolean;
  error: Error | null;
  /** Compute aggregate stats for a single calendar month. */
  monthStats: (year: number, month1to12: number) => FinanceStatsResponse;
  /** Filter transactions by month (year/month1to12) and optional filters. */
  filteredTransactions: (opts: {
    year?: number | null; // null = no month filter (show all)
    month?: number | null;
    category?: string | null;
    detailsSearch?: string;
  }) => Transaction[];
  refetch: () => Promise<void>;
  createTransaction: (input: CreateTransactionInput) => Promise<CreateTransactionResult>;
  updateTransaction: (
    id: string,
    patch: UpdateTransactionInput,
  ) => Promise<CreateTransactionResult>;
  deleteTransaction: (id: string) => Promise<{ id: string }>;
  upsertBudget: (category: string, monthlyLimit: number) => Promise<Budget>;
  deleteBudget: (category: string) => Promise<{ category: string }>;
  createCategory: (name: string) => Promise<Category>;
  renameCategory: (oldName: string, newName: string) => Promise<{ oldName: string; newName: string }>;
  deleteCategory: (name: string) => Promise<{ name: string }>;
}

async function parseError(res: Response, fallback: string): Promise<Error> {
  let body: { error?: string } = {};
  try {
    body = (await res.json()) as { error?: string };
  } catch {
    // body wasn't JSON — use fallback
  }
  return new Error(body.error || fallback);
}

function monthBoundsMs(year: number, month1to12: number): { startMs: number; endMs: number } {
  const startMs = Date.UTC(year, month1to12 - 1, 1, 0, 0, 0, 0);
  const endMs = Date.UTC(year, month1to12, 1, 0, 0, 0, 0);
  return { startMs, endMs };
}

export function useFinance(): UseFinanceState {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [categories, setCategories] = useState<CategoryWithCount[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Guard against overlapping fetches.
  const inFlightRef = useRef<Promise<void> | null>(null);

  const refetch = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current;
    const p = (async () => {
      setIsLoading(true);
      try {
        const [txRes, bRes, cRes] = await Promise.all([
          fetch("/api/finance", { cache: "no-store" }),
          fetch("/api/finance/budgets", { cache: "no-store" }),
          fetch("/api/finance/categories", { cache: "no-store" }),
        ]);
        if (!txRes.ok) {
          throw await parseError(txRes, `Failed to load transactions (${txRes.status})`);
        }
        if (!bRes.ok) {
          throw await parseError(bRes, `Failed to load budgets (${bRes.status})`);
        }
        if (!cRes.ok) {
          throw await parseError(cRes, `Failed to load categories (${cRes.status})`);
        }
        const txData = (await txRes.json()) as { transactions: Transaction[] };
        const bData = (await bRes.json()) as { budgets: Budget[] };
        const cData = (await cRes.json()) as { categories: CategoryWithCount[] };
        setTransactions(txData.transactions);
        setBudgets(bData.budgets);
        setCategories(cData.categories);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setIsLoading(false);
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = p;
    return p;
  }, []);

  useEffect(() => {
    void refetch();
    const onFocus = () => {
      void refetch();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [refetch]);

  const filteredTransactions = useCallback(
    (opts: {
      year?: number | null;
      month?: number | null;
      category?: string | null;
      detailsSearch?: string;
    }) => {
      let out = transactions;
      if (opts.year !== null && opts.year !== undefined &&
          opts.month !== null && opts.month !== undefined) {
        const { startMs, endMs } = monthBoundsMs(opts.year, opts.month);
        out = out.filter((t) => t.date >= startMs && t.date < endMs);
      }
      if (opts.category && opts.category.length > 0) {
        out = out.filter((t) => t.category === opts.category);
      }
      if (opts.detailsSearch && opts.detailsSearch.length > 0) {
        const q = opts.detailsSearch.toLowerCase();
        out = out.filter((t) =>
          typeof t.details === "string" && t.details.toLowerCase().includes(q),
        );
      }
      return out;
    },
    [transactions],
  );

  const monthStats = useCallback(
    (year: number, month1to12: number): FinanceStatsResponse => {
      const { startMs, endMs } = monthBoundsMs(year, month1to12);
      const budgetMap = new Map(budgets.map((b) => [b.category, b.monthlyLimit]));

      let totalIncome = 0;
      let totalExpense = 0;
      let count = 0;
      const byCategoryMap = new Map<
        string,
        { total: number; direction: FinanceDirection }
      >();
      for (const t of transactions) {
        if (t.date < startMs || t.date >= endMs) continue;
        count += 1;
        if (t.direction === "income") {
          totalIncome += t.amount;
        } else {
          totalExpense += t.amount;
        }
        const key = `${t.direction} ${t.category}`;
        const existing = byCategoryMap.get(key);
        if (existing) {
          existing.total += t.amount;
        } else {
          byCategoryMap.set(key, { total: t.amount, direction: t.direction });
        }
      }
      const byCategory = Array.from(byCategoryMap.entries())
        .map(([key, v]) => {
          const category = key.slice(v.direction.length + 1);
          const limit = budgetMap.get(category);
          return {
            category,
            total: v.total,
            direction: v.direction,
            ...(limit !== undefined ? { budgetLimit: limit } : {}),
          };
        })
        .sort((a, b) => b.total - a.total);

      return {
        month: { year, month: month1to12 },
        totalIncome,
        totalExpense,
        net: totalIncome - totalExpense,
        count,
        byCategory,
      };
    },
    [transactions, budgets],
  );

  const createTransaction = useCallback(
    async (input: CreateTransactionInput): Promise<CreateTransactionResult> => {
      const res = await fetch("/api/finance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw await parseError(res, "Failed to save entry");
      const data = (await res.json()) as CreateTransactionResult;
      await refetch();
      return data;
    },
    [refetch],
  );

  const updateTransaction = useCallback(
    async (id: string, patch: UpdateTransactionInput): Promise<CreateTransactionResult> => {
      const res = await fetch(`/api/finance/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw await parseError(res, "Failed to update entry");
      const data = (await res.json()) as CreateTransactionResult;
      await refetch();
      return data;
    },
    [refetch],
  );

  const deleteTransaction = useCallback(
    async (id: string): Promise<{ id: string }> => {
      const res = await fetch(`/api/finance/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw await parseError(res, "Failed to delete entry");
      const data = (await res.json()) as { id: string };
      await refetch();
      return data;
    },
    [refetch],
  );

  const upsertBudget = useCallback(
    async (category: string, monthlyLimit: number): Promise<Budget> => {
      const res = await fetch("/api/finance/budgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, monthlyLimit }),
      });
      if (!res.ok) throw await parseError(res, "Failed to save budget");
      const data = (await res.json()) as { budget: Budget };
      await refetch();
      return data.budget;
    },
    [refetch],
  );

  const deleteBudget = useCallback(
    async (category: string): Promise<{ category: string }> => {
      const res = await fetch(
        `/api/finance/budgets/${encodeURIComponent(category)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw await parseError(res, "Failed to delete budget");
      const data = (await res.json()) as { category: string };
      await refetch();
      return data;
    },
    [refetch],
  );

  const createCategory = useCallback(
    async (name: string): Promise<Category> => {
      const res = await fetch("/api/finance/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw await parseError(res, "Failed to create category");
      const data = (await res.json()) as { category: Category };
      await refetch();
      return data.category;
    },
    [refetch],
  );

  const renameCategory = useCallback(
    async (oldName: string, newName: string): Promise<{ oldName: string; newName: string }> => {
      const res = await fetch("/api/finance/categories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldName, newName }),
      });
      if (!res.ok) throw await parseError(res, "Failed to rename category");
      const data = (await res.json()) as { oldName: string; newName: string };
      await refetch();
      return data;
    },
    [refetch],
  );

  const deleteCategory = useCallback(
    async (name: string): Promise<{ name: string }> => {
      const res = await fetch(
        `/api/finance/categories/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw await parseError(res, "Failed to delete category");
      const data = (await res.json()) as { name: string };
      await refetch();
      return data;
    },
    [refetch],
  );

  return {
    transactions,
    budgets,
    categories,
    isLoading,
    error,
    monthStats,
    filteredTransactions,
    refetch,
    createTransaction,
    updateTransaction,
    deleteTransaction,
    upsertBudget,
    deleteBudget,
    createCategory,
    renameCategory,
    deleteCategory,
  };
}