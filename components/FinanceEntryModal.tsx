"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { FinanceDirection } from "@/lib/finance-schema";
import type { CategoryWithCount } from "@/hooks/useFinance";

export interface FinanceEntryModalInitialValues {
  id?: string;
  date?: number;
  amount?: number;
  direction?: FinanceDirection;
  category?: string;
  details?: string;
}

interface FinanceEntryModalProps {
  initial?: FinanceEntryModalInitialValues;
  /**
   * When true the modal is in "edit" mode (id is required and present).
   * When false the modal is in "create" mode.
   */
  mode: "create" | "edit";
  categories: CategoryWithCount[];
  onSubmit: (input: {
    date: number;
    amount: number;
    direction: FinanceDirection;
    category: string;
    details: string;
  }) => Promise<void>;
  onCreateCategory: (name: string) => Promise<void>;
  onClose: () => void;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDateInput(value: string): number {
  // Treat the input as local noon of the selected date (avoids TZ off-by-one).
  const [y, m, day] = value.split("-").map((s) => Number(s));
  return new Date(y, m - 1, day, 12, 0, 0, 0).getTime();
}

export function FinanceEntryModal({
  initial,
  mode,
  categories,
  onSubmit,
  onCreateCategory,
  onClose,
}: FinanceEntryModalProps) {
  const { t } = useI18n();
  const [dateStr, setDateStr] = useState(() =>
    dateInputValue(initial?.date ?? Date.now()),
  );
  const [amount, setAmount] = useState(
    initial?.amount !== undefined ? String(initial.amount) : "",
  );
  const [direction, setDirection] = useState<FinanceDirection>(
    initial?.direction ?? "expense",
  );
  const [details, setDetails] = useState(initial?.details ?? "");
  // Category: separate "value" (what's in the input) from "committed" (what's
  // selected from the datalist). Lets users type a new category name and
  // commit it on submit without it being silently lost.
  const [categoryValue, setCategoryValue] = useState(initial?.category ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const categoryNames = useMemo(() => categories.map((c) => c.name), [categories]);
  const trimmedCategory = categoryValue.trim();
  const trimmedAmount = amount.trim();
  const trimmedDetails = details.trim();
  const canSubmit =
    trimmedCategory.length > 0 &&
    trimmedAmount.length > 0 &&
    trimmedDetails.length > 0 &&
    !submitting &&
    Number.isFinite(Number(trimmedAmount)) &&
    Number(trimmedAmount) > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Auto-create the category if it doesn't exist (matches the server-side
      // auto-registration on POST/PATCH, so the user's typed name survives).
      if (!categoryNames.includes(trimmedCategory)) {
        try {
          await onCreateCategory(trimmedCategory);
        } catch {
          // ignore — the server will register it again on POST, but if that
          // also fails the actual createTransaction will surface the error.
        }
      }
      await onSubmit({
        date: parseDateInput(dateStr),
        amount: Number(trimmedAmount),
        direction,
        category: trimmedCategory,
        details: trimmedDetails,
      });
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 20,
          minWidth: 360,
          maxWidth: 480,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--border)",
            paddingBottom: 10,
          }}
        >
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: "var(--text)" }}>
            {mode === "create" ? t("New entry") : t("Edit entry")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close")}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 18,
              cursor: "pointer",
              padding: 0,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <Field label={t("Date")} required>
          <input
            type="date"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
            style={inputStyle}
          />
        </Field>

        <Field label={t("Amount")} required>
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            style={inputStyle}
          />
        </Field>

        <Field label={t("Direction")} required>
          <div
            role="tablist"
            aria-label={t("Direction")}
            style={{
              display: "flex",
              border: "1px solid var(--border)",
              borderRadius: 4,
              overflow: "hidden",
              width: "fit-content",
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
                padding: "6px 14px",
                fontSize: 13,
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
                padding: "6px 14px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("Income")}
            </button>
          </div>
        </Field>

        <Field label={t("Details")} required>
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder={t("What was this for?")}
            rows={2}
            style={{
              ...inputStyle,
              resize: "vertical",
              minHeight: 40,
              fontFamily: "var(--font-sans)",
            }}
          />
        </Field>

        <Field label={t("Category")} required>
          <input
            type="text"
            value={categoryValue}
            onChange={(e) => setCategoryValue(e.target.value)}
            placeholder={t("Category")}
            list="finance-categories-list"
            style={inputStyle}
          />
          <datalist id="finance-categories-list">
            {categoryNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {!categoryNames.includes(trimmedCategory) && trimmedCategory.length > 0 && (
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {t("Will be added as a new category")}
            </span>
          )}
        </Field>

        {submitError && (
          <div
            style={{
              color: "#ef4444",
              fontSize: 12,
              padding: 8,
              border: "1px solid #ef4444",
              borderRadius: 4,
            }}
          >
            {submitError}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            borderTop: "1px solid var(--border)",
            paddingTop: 10,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              borderRadius: 4,
              padding: "6px 14px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {t("Cancel")}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              background: canSubmit ? "var(--accent)" : "var(--bg-subtle)",
              color: canSubmit ? "var(--bg)" : "var(--text-muted)",
              border: "none",
              borderRadius: 4,
              padding: "6px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >
            {t("Save")}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
        {label}
        {required && <span style={{ color: "#ef4444", marginLeft: 2 }}>*</span>}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 13,
  color: "var(--text)",
  outline: "none",
  fontFamily: "var(--font-sans)",
};