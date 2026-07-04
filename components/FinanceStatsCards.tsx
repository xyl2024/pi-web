"use client";

import { useI18n } from "@/hooks/useI18n";
import type { FinanceStatsResponse } from "@/lib/finance-schema";

interface FinanceStatsCardsProps {
  stats: FinanceStatsResponse;
}

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Four top stat cards: total income / total expense / net / count.
 * Net is colored green when positive, red when negative.
 */
export function FinanceStatsCards({ stats }: FinanceStatsCardsProps) {
  const { t } = useI18n();
  const netColor =
    stats.net > 0
      ? "var(--accent)"
      : stats.net < 0
        ? "#f87171"
        : "var(--text)";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 8,
        padding: "8px 12px",
      }}
    >
      <StatCard label={t("Total income")} value={`¥${fmtMoney(stats.totalIncome)}`} />
      <StatCard label={t("Total expense")} value={`¥${fmtMoney(stats.totalExpense)}`} />
      <StatCard
        label={t("Net")}
        value={`${stats.net >= 0 ? "+" : ""}¥${fmtMoney(stats.net)}`}
        valueColor={netColor}
      />
      <StatCard label={t("Transactions")} value={String(stats.count)} />
    </div>
  );
}

function StatCard({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "8px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{label}</span>
      <span
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: valueColor ?? "var(--text)",
          fontFamily: "var(--font-mono)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
    </div>
  );
}