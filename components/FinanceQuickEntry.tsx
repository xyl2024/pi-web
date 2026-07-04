"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import type { FinanceDirection } from "@/lib/finance-schema";
import type { CategoryWithCount } from "@/hooks/useFinance";

interface FinanceQuickEntryProps {
  categories: CategoryWithCount[];
  onSubmit: (input: {
    date: number;
    amount: number;
    direction: FinanceDirection;
    category: string;
    details: string;
  }) => Promise<void>;
  onCreateCategory: (name: string) => Promise<void>;
}

/**
 * Top sticky quick-entry strip. Fields (left → right):
 *   direction toggle | amount | details (was category slot) | category
 * Defaults to today's date, expense.
 */
export function FinanceQuickEntry({ categories, onSubmit, onCreateCategory }: FinanceQuickEntryProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [direction, setDirection] = useState<FinanceDirection>("expense");
  const [amount, setAmount] = useState("");
  const [details, setDetails] = useState("");
  const [category, setCategory] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const trimmedAmount = amount.trim();
    const trimmedDetails = details.trim();
    const trimmedCategory = category.trim();
    if (!trimmedAmount || !trimmedDetails || !trimmedCategory) {
      toast.show({
        kind: "error",
        message: t("Amount, details, and category are required"),
      });
      return;
    }
    const amt = Number(trimmedAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.show({
        kind: "error",
        message: t("Amount must be a positive number"),
      });
      return;
    }
    setSubmitting(true);
    try {
      // Auto-register the category if the user typed a new name.
      const knownNames = categories.map((c) => c.name);
      if (!knownNames.includes(trimmedCategory)) {
        try {
          await onCreateCategory(trimmedCategory);
        } catch {
          // ignore — server will register it via the POST too
        }
      }
      await onSubmit({
        // Default date to today at noon (avoids TZ off-by-one edge cases).
        date: Date.now(),
        amount: amt,
        direction,
        category: trimmedCategory,
        details: trimmedDetails,
      });
      setAmount("");
      setDetails("");
      setCategory("");
    } catch (e) {
      toast.show({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        alignItems: "center",
        padding: 8,
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        role="tablist"
        aria-label={t("Direction")}
        style={{
          display: "flex",
          border: "1px solid var(--border)",
          borderRadius: 4,
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={direction === "expense"}
          onClick={() => setDirection("expense")}
          style={{
            background: direction === "expense" ? "var(--accent)" : "transparent",
            color: direction === "expense" ? "var(--bg)" : "var(--text-muted)",
            border: "none",
            padding: "4px 10px",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {t("Expense")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={direction === "income"}
          onClick={() => setDirection("income")}
          style={{
            background: direction === "income" ? "var(--accent)" : "transparent",
            color: direction === "income" ? "var(--bg)" : "var(--text-muted)",
            border: "none",
            padding: "4px 10px",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {t("Income")}
        </button>
      </div>
      <input
        type="number"
        step="0.01"
        min="0"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !submitting) {
            e.preventDefault();
            void handleSubmit();
          }
        }}
        placeholder={t("Amount")}
        aria-label={t("Amount")}
        style={{
          ...inputStyle,
          width: 90,
          flexShrink: 0,
        }}
      />
      <input
        type="text"
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !submitting) {
            e.preventDefault();
            void handleSubmit();
          }
        }}
        placeholder={t("Details")}
        aria-label={t("Details")}
        style={{ ...inputStyle, flex: 1.2, minWidth: 80 }}
      />
      <input
        type="text"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !submitting) {
            e.preventDefault();
            void handleSubmit();
          }
        }}
        placeholder={t("Category")}
        aria-label={t("Category")}
        list="finance-quick-categories-list"
        style={{ ...inputStyle, flex: 1, minWidth: 80 }}
      />
      <datalist id="finance-quick-categories-list">
        {categories.map((c) => (
          <option key={c.name} value={c.name} />
        ))}
      </datalist>
      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={submitting}
        style={{
          background: "var(--accent)",
          color: "var(--bg)",
          border: "none",
          borderRadius: 4,
          padding: "4px 12px",
          fontSize: 12,
          fontWeight: 600,
          cursor: submitting ? "not-allowed" : "pointer",
          opacity: submitting ? 0.6 : 1,
          flexShrink: 0,
        }}
      >
        {t("Save")}
      </button>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "4px 8px",
  fontSize: 13,
  color: "var(--text)",
  outline: "none",
  fontFamily: "var(--font-sans)",
};