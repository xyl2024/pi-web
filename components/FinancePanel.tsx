"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { useFinance } from "@/hooks/useFinance";
import { FinanceQuickEntry } from "./FinanceQuickEntry";
import { FinanceEntryModal } from "./FinanceEntryModal";
import { FinanceStatsCards } from "./FinanceStatsCards";
import { FinanceBudgetCard } from "./FinanceBudgetCard";
import { FinanceBudgetModal } from "./FinanceBudgetModal";
import { FinanceTransactionList } from "./FinanceTransactionList";
import type {
  FinanceDirection,
  Transaction,
} from "@/lib/finance-schema";

interface EntryModalState {
  open: boolean;
  mode: "create" | "edit";
  /** Pre-filled values for edit mode. */
  initial?: {
    id?: string;
    date?: number;
    amount?: number;
    direction?: FinanceDirection;
    category?: string;
    details?: string;
  };
}

function nowYearMonth(): { year: number; month: number } {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function fmtMonthLabel(year: number, month1to12: number): string {
  return `${year}-${String(month1to12).padStart(2, "0")}`;
}

/**
 * Right-side tab body for the daily-accounting feature.
 *
 * Layout:
 *   - Top toolbar (month switcher + "全部" + export button + ⌘N entry shortcut)
 *   - FinanceBudgetCard (top of scroll area)
 *   - FinanceStatsCards (4 cards)
 *   - FinanceQuickEntry (sticky)
 *   - Category filter + note search bar
 *   - FinanceTransactionList
 *
 * Modal states are local to this component; the data hook is global.
 */
export function FinancePanel() {
  const { t } = useI18n();
  const toast = useToast();
  const {
    transactions,
    budgets,
    isLoading,
    error,
    categories,
    monthStats,
    filteredTransactions,
    createTransaction,
    updateTransaction,
    deleteTransaction,
    upsertBudget,
    deleteBudget,
  } = useFinance();

  // Default to current month; "全部" sets both to null.
  const [month, setMonth] = useState<{ year: number; month: number } | null>(
    () => nowYearMonth(),
  );
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [noteSearch, setNoteSearch] = useState("");
  const [entryModal, setEntryModal] = useState<EntryModalState>({
    open: false,
    mode: "create",
  });
  const [budgetModalOpen, setBudgetModalOpen] = useState(false);

  // Stats: either for the selected month or aggregated over all time when
  // month is null. For "全部" we use the transactions list directly.
  const stats = useMemo(() => {
    if (month === null) {
      // Aggregate across all transactions.
      let totalIncome = 0;
      let totalExpense = 0;
      const byCategoryMap = new Map<
        string,
        { total: number; direction: FinanceDirection }
      >();
      for (const tr of transactions) {
        if (tr.direction === "income") {
          totalIncome += tr.amount;
        } else {
          totalExpense += tr.amount;
        }
        const key = `${tr.direction} ${tr.category}`;
        const existing = byCategoryMap.get(key);
        if (existing) {
          existing.total += tr.amount;
        } else {
          byCategoryMap.set(key, { total: tr.amount, direction: tr.direction });
        }
      }
      const budgetMap = new Map(budgets.map((b) => [b.category, b.monthlyLimit]));
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
      const d = new Date();
      return {
        month: { year: d.getFullYear(), month: d.getMonth() + 1 },
        totalIncome,
        totalExpense,
        net: totalIncome - totalExpense,
        count: transactions.length,
        byCategory,
      };
    }
    return monthStats(month.year, month.month);
  }, [month, transactions, budgets, monthStats]);

  const visible = useMemo(
    () =>
      filteredTransactions({
        year: month?.year ?? null,
        month: month?.month ?? null,
        category: selectedCategory,
        detailsSearch: noteSearch,
      }),
    [filteredTransactions, month, selectedCategory, noteSearch],
  );

  // ⌘⌥N (Ctrl+Alt+N) opens the entry modal in create mode. Listener attached
  // at window scope so it works regardless of focus; AppShell also wires the
  // tab-opening half of this shortcut. Avoids the existing ⌘N (Notes) binding.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.altKey && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        e.stopPropagation();
        setEntryModal({ open: true, mode: "create" });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const handleSubmitCreate = useCallback(
    async (input: {
      date: number;
      amount: number;
      direction: FinanceDirection;
      category: string;
      details: string;
    }) => {
      try {
        const result = await createTransaction(input);
        toast.show({ kind: "success", message: t("Entry saved") });
        if (result.budgetWarning) {
          toast.show({
            kind: "info",
            message: t(
              "Budget exceeded for {category} ({spent} of {limit})",
            )
              .replace("{category}", result.budgetWarning.category)
              .replace("{spent}", `¥${result.budgetWarning.spent.toFixed(2)}`)
              .replace("{limit}", `¥${result.budgetWarning.monthlyLimit.toFixed(2)}`),
          });
        }
      } catch (e) {
        toast.show({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    },
    [createTransaction, toast, t],
  );

  const handleSubmitEdit = useCallback(
    async (input: {
      date: number;
      amount: number;
      direction: FinanceDirection;
      category: string;
      details: string;
    }) => {
      if (!entryModal.initial?.id) {
        throw new Error("missing id for edit");
      }
      try {
        const result = await updateTransaction(entryModal.initial.id, input);
        toast.show({ kind: "success", message: t("Entry updated") });
        if (result.budgetWarning) {
          toast.show({
            kind: "info",
            message: t("Budget exceeded for {category}")
              .replace("{category}", result.budgetWarning.category),
          });
        }
      } catch (e) {
        toast.show({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    },
    [entryModal.initial, updateTransaction, toast, t],
  );

  const handleEditRow = useCallback((tr: Transaction) => {
    setEntryModal({
      open: true,
      mode: "edit",
      initial: {
        id: tr.id,
        date: tr.date,
        amount: tr.amount,
        direction: tr.direction,
        category: tr.category,
        details: tr.details,
      },
    });
  }, []);

  const handleExport = useCallback(() => {
    window.location.href = "/api/finance/export";
  }, []);

  const goPrevMonth = () => {
    if (month === null) {
      // From "全部" jumping back, fall back to current month.
      setMonth(nowYearMonth());
      return;
    }
    const m = month.month === 1
      ? { year: month.year - 1, month: 12 }
      : { year: month.year, month: month.month - 1 };
    setMonth(m);
  };
  const goNextMonth = () => {
    if (month === null) return;
    const m = month.month === 12
      ? { year: month.year + 1, month: 1 }
      : { year: month.year, month: month.month + 1 };
    setMonth(m);
  };

  const monthLabel = month === null ? t("All months") : fmtMonthLabel(month.year, month.month);

  if (error && transactions.length === 0) {
    return (
      <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
        {t("Failed to load finance")}: {error.message}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg)",
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        <button
          type="button"
          onClick={goPrevMonth}
          aria-label={t("Previous month")}
          disabled={month === null}
          style={monthNavButtonStyle(month !== null)}
        >
          ‹
        </button>
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            minWidth: 80,
            textAlign: "center",
          }}
        >
          {monthLabel}
        </span>
        <button
          type="button"
          onClick={goNextMonth}
          aria-label={t("Next month")}
          disabled={month === null}
          style={monthNavButtonStyle(month !== null)}
        >
          ›
        </button>
        <button
          type="button"
          onClick={() => setMonth(null)}
          disabled={month === null}
          style={pillButtonStyle(month === null)}
        >
          {t("All months")}
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={handleExport}
          title={t("Export CSV")}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
            borderRadius: 4,
            padding: "4px 10px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {t("Export CSV")}
        </button>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
        <FinanceBudgetCard
          budgets={budgets}
          stats={stats}
          onEditBudgets={() => setBudgetModalOpen(true)}
        />
        <FinanceStatsCards stats={stats} />

        {/* Filter row */}
        <div
          style={{
            display: "flex",
            gap: 6,
            padding: "6px 12px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          <select
            value={selectedCategory ?? ""}
            onChange={(e) =>
              setSelectedCategory(e.target.value === "" ? null : e.target.value)
            }
            aria-label={t("Filter by category")}
            style={filterInputStyle}
          >
            <option value="">{t("All categories")}</option>
            {categories.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.count})
              </option>
            ))}
          </select>
          <input
            type="text"
            value={noteSearch}
            onChange={(e) => setNoteSearch(e.target.value)}
            placeholder={t("Search notes…")}
            aria-label={t("Search notes")}
            style={{ ...filterInputStyle, flex: 1, minWidth: 0 }}
          />
          {(selectedCategory !== null || noteSearch.length > 0) && (
            <button
              type="button"
              onClick={() => {
                setSelectedCategory(null);
                setNoteSearch("");
              }}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                borderRadius: 4,
                padding: "4px 10px",
                fontSize: 11,
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              {t("Reset")}
            </button>
          )}
        </div>

        <FinanceTransactionList
          transactions={visible}
          onEdit={handleEditRow}
          onDeleted={() => {
            /* refetch happens inside the hook */
          }}
          deleteTransaction={deleteTransaction}
        />

        {isLoading && transactions.length === 0 && (
          <div
            style={{
              padding: 16,
              color: "var(--text-muted)",
              fontSize: 12,
              textAlign: "center",
            }}
          >
            {t("Loading…")}
          </div>
        )}
      </div>

      {/* Quick entry strip — sticky at bottom */}
      <FinanceQuickEntry
        categories={categories}
        onSubmit={handleSubmitCreate}
      />

      {/* Modals */}
      {entryModal.open && (
        <FinanceEntryModal
          mode={entryModal.mode}
          initial={entryModal.initial}
          categories={categories}
          onSubmit={entryModal.mode === "edit" ? handleSubmitEdit : handleSubmitCreate}
          onClose={() => setEntryModal({ open: false, mode: "create" })}
        />
      )}
      {budgetModalOpen && (
        <FinanceBudgetModal
          initial={budgets}
          upsertBudget={upsertBudget}
          deleteBudget={deleteBudget}
          onClose={() => setBudgetModalOpen(false)}
        />
      )}
    </div>
  );
}

const baseIconStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--text-muted)",
  fontSize: 14,
  lineHeight: 1,
  padding: "2px 8px",
  cursor: "pointer",
};

function monthNavButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    ...baseIconStyle,
    opacity: enabled ? 1 : 0.4,
    cursor: enabled ? "pointer" : "not-allowed",
  };
}

function pillButtonStyle(active: boolean): React.CSSProperties {
  return {
    ...baseIconStyle,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "var(--bg)" : "var(--text-muted)",
    borderColor: active ? "var(--accent)" : "var(--border)",
    opacity: active ? 1 : 0.7,
  };
}

const filterInputStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "4px 8px",
  fontSize: 12,
  color: "var(--text)",
  outline: "none",
  fontFamily: "var(--font-sans)",
};