"use client";

import { useI18n } from "@/hooks/useI18n";
import type { Budget, FinanceStatsResponse } from "@/lib/finance-schema";

interface FinanceBudgetCardProps {
  budgets: Budget[];
  stats: FinanceStatsResponse;
  onEditBudgets: () => void;
}

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Top "本月预算总览" card. Shows total spend across budgeted categories
 * vs the sum of their monthly limits. Per-category breakdown below.
 * Hidden when there are zero budgets.
 */
export function FinanceBudgetCard({
  budgets,
  stats,
  onEditBudgets,
}: FinanceBudgetCardProps) {
  const { t } = useI18n();

  if (budgets.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "8px 12px",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
        }}
      >
        <span style={{ color: "var(--text-muted)" }}>
          {t("No budgets set")}
        </span>
        <button
          type="button"
          onClick={onEditBudgets}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          + {t("Budget")}
        </button>
      </div>
    );
  }

  // Per-budgeted-category expense + limit, derived from stats.byCategory.
  const budgetMap = new Map(budgets.map((b) => [b.category, b.monthlyLimit]));
  const rows = stats.byCategory
    .filter((r) => r.direction === "expense" && budgetMap.has(r.category))
    .map((r) => ({
      category: r.category,
      spent: r.total,
      limit: budgetMap.get(r.category)!,
    }))
    .sort((a, b) => b.spent / b.limit - a.spent / a.limit);

  const totalSpent = rows.reduce((acc, r) => acc + r.spent, 0);
  const totalLimit = rows.reduce((acc, r) => acc + r.limit, 0);
  const totalRatio = totalLimit > 0 ? totalSpent / totalLimit : 0;
  const totalOver = totalSpent > totalLimit;

  return (
    <div
      style={{
        padding: "8px 12px",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {t("Budget overview")}
          </span>
          <span
            style={{
              fontSize: 14,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              color: totalOver ? "#f87171" : "var(--text)",
            }}
          >
            ¥{fmtMoney(totalSpent)} / ¥{fmtMoney(totalLimit)}
          </span>
        </div>
        <button
          type="button"
          onClick={onEditBudgets}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 11,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {t("Edit budgets")}
        </button>
      </div>
      {totalRatio > 0 && (
        <div
          style={{
            height: 4,
            background: "var(--bg-subtle)",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.min(100, totalRatio * 100)}%`,
              height: "100%",
              background: totalOver ? "#f87171" : "var(--accent)",
              transition: "width 200ms ease",
            }}
          />
        </div>
      )}
      {rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
          {rows.map((r) => {
            const over = r.spent > r.limit;
            const ratio = r.limit > 0 ? r.spent / r.limit : 0;
            return (
              <div
                key={r.category}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto auto",
                  gap: 8,
                  fontSize: 11,
                  color: over ? "#f87171" : "var(--text-muted)",
                  alignItems: "center",
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.category}
                </span>
                <div
                  style={{
                    height: 3,
                    width: 60,
                    background: "var(--bg-subtle)",
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, ratio * 100)}%`,
                      height: "100%",
                      background: over ? "#f87171" : "var(--accent)",
                    }}
                  />
                </div>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    minWidth: 100,
                    textAlign: "right",
                  }}
                >
                  ¥{fmtMoney(r.spent)} / ¥{fmtMoney(r.limit)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}