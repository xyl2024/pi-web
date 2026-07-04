"use client";

import { useI18n } from "@/hooks/useI18n";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import type { Transaction } from "@/lib/finance-schema";

interface FinanceTransactionListProps {
  transactions: Transaction[];
  onEdit: (t: Transaction) => void;
  onDeleted: () => void;
  deleteTransaction: (id: string) => Promise<{ id: string }>;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function FinanceTransactionList({
  transactions,
  onEdit,
  onDeleted,
  deleteTransaction,
}: FinanceTransactionListProps) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const toast = useToast();

  const handleDelete = async (t_row: Transaction) => {
    const ok = await confirm({
      title: t("Delete entry?"),
      description: t("Delete this transaction?"),
      confirmLabel: t("Delete"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteTransaction(t_row.id);
      toast.show({ kind: "success", message: t("Entry deleted") });
      onDeleted();
    } catch (e) {
      toast.show({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  if (transactions.length === 0) {
    return (
      <div
        style={{
          padding: "32px 16px",
          textAlign: "center",
          color: "var(--text-muted)",
          fontStyle: "italic",
          fontSize: 13,
        }}
      >
        {t("No transactions yet this month")}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {transactions.map((row) => {
        const isExpense = row.direction === "expense";
        return (
          <div
            key={row.id}
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr auto auto auto",
              gap: 8,
              alignItems: "center",
              padding: "6px 12px",
              borderBottom: "1px solid var(--border)",
              fontSize: 13,
            }}
          >
            <span
              style={{
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                minWidth: 84,
              }}
            >
              {fmtDate(row.date)}
            </span>
            <span
              style={{
                color: "var(--text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={row.details}
            >
              <span
                style={{
                  display: "inline-block",
                  padding: "1px 6px",
                  background: "var(--bg-subtle)",
                  borderRadius: 3,
                  marginRight: 6,
                  fontSize: 11,
                  color: "var(--text-muted)",
                  flexShrink: 0,
                }}
              >
                {row.category}
              </span>
              <span
                style={{
                  color: "var(--text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.details}
              </span>
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                color: isExpense ? "#f87171" : "var(--accent)",
                minWidth: 80,
                textAlign: "right",
              }}
            >
              {isExpense ? "-" : "+"}¥{fmtMoney(row.amount)}
            </span>
            <button
              type="button"
              onClick={() => onEdit(row)}
              aria-label={t("Edit entry")}
              title={t("Edit")}
              style={iconButtonStyle}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 2l3 3-8 8H3v-3l8-8z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => void handleDelete(row)}
              aria-label={t("Delete entry")}
              title={t("Delete")}
              style={iconButtonStyle}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 4h10M6 4V2.5h4V4M5 4l1 9h4l1-9" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
  padding: 4,
  borderRadius: 4,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};