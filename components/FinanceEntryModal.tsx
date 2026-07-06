"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { FINANCE_PRESET_CATEGORIES } from "@/lib/finance-preset-categories";
import type { FinanceDirection } from "@/lib/finance-schema";
import type { CategoryWithCount } from "@/hooks/useFinance";
import {
  detectActiveCategoryToken,
  FinanceCategoryPopover,
} from "./FinanceCategoryPopover";

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
  /** Used to render a small usage count next to each preset in the picker. */
  categories: CategoryWithCount[];
  onSubmit: (input: {
    date: number;
    amount: number;
    direction: FinanceDirection;
    category: string;
    details: string;
  }) => Promise<void>;
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
  const [selectionStart, setSelectionStart] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dropdownDismissed, setDropdownDismissed] = useState(false);
  const detailsRef = useRef<HTMLTextAreaElement | null>(null);
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

  // Detect an in-progress `#xxx` token at the cursor in the details textarea.
  const activeToken = useMemo(
    () => detectActiveCategoryToken(details, selectionStart),
    [details, selectionStart],
  );

  const countsByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of categories) m.set(c.name, c.count);
    return m;
  }, [categories]);

  const dropdownItems = useMemo(() => {
    if (!activeToken) return [];
    const q = activeToken.query.toLowerCase();
    return FINANCE_PRESET_CATEGORIES
      .filter((name) => name.toLowerCase().includes(q))
      .map((name) => ({ name, count: countsByName.get(name) ?? 0 }));
  }, [activeToken, countsByName]);

  useEffect(() => {
    setActiveIndex(0);
  }, [activeToken?.start, activeToken?.query, dropdownItems.length]);

  useEffect(() => {
    if (!activeToken) setDropdownDismissed(false);
  }, [activeToken]);

  const dropdownOpen =
    activeToken !== null && !dropdownDismissed && dropdownItems.length > 0;

  const commitCategory = (name: string) => {
    if (!activeToken) return;
    // Replace the `#xxx` token with `#<name> ` (trailing space jumps the
    // cursor out of the picker zone so further typing lands in the
    // description).
    const next =
      details.slice(0, activeToken.start) + `#${name} ` + details.slice(activeToken.end);
    const newCursor = activeToken.start + 1 + name.length + 1;
    setDetails(next);
    setSelectionStart(newCursor);
    setActiveIndex(0);
    setDropdownDismissed(false);
    requestAnimationFrame(() => {
      if (detailsRef.current) {
        detailsRef.current.focus();
        detailsRef.current.setSelectionRange(newCursor, newCursor);
      }
    });
  };

  const trimmedAmount = amount.trim();
  const trimmedDetails = details.trim();
  const canSubmit =
    trimmedDetails.length > 0 &&
    trimmedAmount.length > 0 &&
    !submitting &&
    Number.isFinite(Number(trimmedAmount)) &&
    Number(trimmedAmount) > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // The server (`createTransaction` / `updateTransaction`) parses
      // `details` for an embedded `#<preset>` token and strips it. We pass
      // the existing `initial.category` so the server has a fallback in
      // edit mode (where no token may be present).
      await onSubmit({
        date: parseDateInput(dateStr),
        amount: Number(trimmedAmount),
        direction,
        category: initial?.category ?? "",
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

        <Field
          label={t("Details")}
          required
          hint={t("# to pick a category")}
        >
          <textarea
            ref={detailsRef}
            value={details}
            onChange={(e) => {
              setDetails(e.target.value);
              setSelectionStart(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => {
              setSelectionStart(e.currentTarget.selectionStart ?? 0);
            }}
            onClick={(e) => {
              setSelectionStart(e.currentTarget.selectionStart ?? 0);
            }}
            onKeyUp={(e) => {
              setSelectionStart(e.currentTarget.selectionStart ?? 0);
            }}
            placeholder={t("What was this for?")}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                if (dropdownOpen) {
                  e.preventDefault();
                  const item = dropdownItems[activeIndex];
                  if (item) commitCategory(item.name);
                }
                // else: let the default submit behavior fire
              } else if (e.key === " " && dropdownOpen) {
                // Space selects the highlighted category when the popover
                // is open. Without this, space inserts whitespace and
                // closes the token (which is the wrong intent here).
                e.preventDefault();
                const item = dropdownItems[activeIndex];
                if (item) commitCategory(item.name);
              } else if (e.key === "Escape") {
                if (dropdownOpen) {
                  e.preventDefault();
                  setDropdownDismissed(true);
                }
              } else if (e.key === "ArrowDown" && dropdownOpen) {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % dropdownItems.length);
              } else if (e.key === "ArrowUp" && dropdownOpen) {
                e.preventDefault();
                setActiveIndex(
                  (i) => (i - 1 + dropdownItems.length) % dropdownItems.length,
                );
              } else if (e.key === "Tab" && dropdownOpen) {
                e.preventDefault();
                const item = dropdownItems[activeIndex];
                if (item) commitCategory(item.name);
              }
            }}
            style={{
              ...inputStyle,
              resize: "vertical",
              minHeight: 40,
              fontFamily: "var(--font-sans)",
            }}
          />
          {dropdownOpen && (
            <FinanceCategoryPopover
              anchorRef={detailsRef}
              items={dropdownItems}
              activeIndex={activeIndex}
              onHover={setActiveIndex}
              onSelect={(i) => {
                const item = dropdownItems[i];
                if (item) commitCategory(item.name);
              }}
              onDismiss={() => setDropdownDismissed(true)}
            />
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
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
        {label}
        {required && <span style={{ color: "#ef4444", marginLeft: 2 }}>*</span>}
        {hint && (
          <span style={{ marginLeft: 8, color: "var(--text-dim)", fontSize: 11 }}>
            {hint}
          </span>
        )}
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
