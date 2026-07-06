"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import type { FinanceDirection } from "@/lib/finance-schema";
import type { CategoryWithCount } from "@/hooks/useFinance";
import {
  detectActiveCategoryToken,
  FinanceCategoryPopover,
} from "./FinanceCategoryPopover";

interface FinanceQuickEntryProps {
  /** Used to render a usage count next to each preset in the picker. */
  categories: CategoryWithCount[];
  onSubmit: (input: {
    date: number;
    amount: number;
    direction: FinanceDirection;
    category: string;
    details: string;
  }) => Promise<void>;
}

/**
 * Top sticky quick-entry strip. Fields (left → right):
 *   direction toggle | amount | details (with `#` category picker) | save
 * Defaults to today's date, expense. Category is picked by typing `#` inside
 * the details input — see `FinanceCategoryPopover` for the picker UX.
 */
export function FinanceQuickEntry({ categories, onSubmit }: FinanceQuickEntryProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [direction, setDirection] = useState<FinanceDirection>("expense");
  const [amount, setAmount] = useState("");
  const [details, setDetails] = useState("");
  const [selectionStart, setSelectionStart] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dropdownDismissed, setDropdownDismissed] = useState(false);
  const detailsRef = useRef<HTMLInputElement | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const activeToken = useMemo(
    () => detectActiveCategoryToken(details, selectionStart),
    [details, selectionStart],
  );

  const dropdownItems = useMemo(() => {
    if (!activeToken) return [];
    const q = activeToken.query.toLowerCase();
    return categories
      .filter((c) => c.name.toLowerCase().includes(q))
      .map((c) => ({ name: c.name, count: c.count }));
  }, [activeToken, categories]);

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

  const handleSubmit = async () => {
    const trimmedAmount = amount.trim();
    const trimmedDetails = details.trim();
    if (!trimmedAmount || !trimmedDetails) {
      toast.show({
        kind: "error",
        message: t("Amount and details are required (# for category)"),
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
      await onSubmit({
        // Default date to today at noon (avoids TZ off-by-one edge cases).
        date: Date.now(),
        amount: amt,
        direction,
        // Server parses `details` for a `#<preset>` token and strips it; we
        // don't need to compute anything client-side.
        category: "",
        details: trimmedDetails,
      });
      setAmount("");
      setDetails("");
      setSelectionStart(0);
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
          if (e.key === "Enter" && !submitting && !dropdownOpen) {
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
        ref={detailsRef}
        type="text"
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
        onKeyDown={(e) => {
          if (e.key === "Enter" && !submitting) {
            e.preventDefault();
            if (dropdownOpen) {
              const item = dropdownItems[activeIndex];
              if (item) commitCategory(item.name);
            } else {
              void handleSubmit();
            }
          } else if (e.key === " " && dropdownOpen && !submitting) {
            // Space selects the highlighted category when the popover is
            // open. Without this, space inserts whitespace and closes the
            // token (which is the wrong intent here).
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
        placeholder={t("Details, # for category")}
        aria-label={t("Details")}
        style={{ ...inputStyle, flex: 1.2, minWidth: 80 }}
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
