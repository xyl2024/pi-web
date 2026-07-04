"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { Budget } from "@/lib/finance-schema";

interface FinanceBudgetModalProps {
  initial: Budget[];
  /**
   * Save a single budget. Replace existing if same category.
   * Returns the saved budget.
   */
  upsertBudget: (category: string, monthlyLimit: number) => Promise<Budget>;
  /**
   * Delete a budget by category. Throws if not found.
   */
  deleteBudget: (category: string) => Promise<{ category: string }>;
  onClose: () => void;
}

interface DraftRow {
  category: string;
  monthlyLimit: string;
}

export function FinanceBudgetModal({
  initial,
  upsertBudget,
  deleteBudget,
  onClose,
}: FinanceBudgetModalProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<DraftRow[]>(() =>
    initial.map((b) => ({
      category: b.category,
      monthlyLimit: String(b.monthlyLimit),
    })),
  );
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

  const handleAddRow = () => {
    setRows((prev) => [...prev, { category: "", monthlyLimit: "" }]);
  };

  const handleRemoveRow = (idx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleRowChange = (
    idx: number,
    patch: Partial<DraftRow>,
  ) => {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  };

  const handleSave = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Determine which categories to delete: present in `initial` but absent
      // (or blank) from the new draft.
      const finalCategories = new Set<string>();
      for (const r of rows) {
        const cat = r.category.trim();
        const lim = Number(r.monthlyLimit);
        if (!cat) continue;
        if (!Number.isFinite(lim) || lim <= 0) {
          setSubmitError(
            t("Monthly limit must be a positive number for {category}")
              .replace("{category}", cat),
          );
          setSubmitting(false);
          return;
        }
        finalCategories.add(cat);
        await upsertBudget(cat, lim);
      }
      for (const b of initial) {
        if (!finalCategories.has(b.category)) {
          await deleteBudget(b.category);
        }
      }
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
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 20,
          minWidth: 420,
          maxWidth: 560,
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
            {t("Budgets")}
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

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 120px 32px",
            gap: 6,
            fontSize: 11,
            color: "var(--text-muted)",
            padding: "0 4px",
          }}
        >
          <span>{t("Category")}</span>
          <span>{t("Monthly limit")}</span>
          <span />
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          {rows.length === 0 && (
            <div
              style={{
                padding: 16,
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: 12,
              }}
            >
              {t("No budgets yet — add one below")}
            </div>
          )}
          {rows.map((row, idx) => (
            <div
              key={idx}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 120px 32px",
                gap: 6,
                alignItems: "center",
              }}
            >
              <input
                type="text"
                value={row.category}
                onChange={(e) =>
                  handleRowChange(idx, { category: e.target.value })
                }
                placeholder={t("Category")}
                style={inputStyle}
              />
              <input
                type="number"
                step="0.01"
                min="0"
                value={row.monthlyLimit}
                onChange={(e) =>
                  handleRowChange(idx, { monthlyLimit: e.target.value })
                }
                placeholder="0.00"
                style={inputStyle}
              />
              <button
                type="button"
                onClick={() => handleRemoveRow(idx)}
                aria-label={t("Delete")}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  padding: 4,
                }}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 4h10M6 4V2.5h4V4M5 4l1 9h4l1-9" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={handleAddRow}
          style={{
            alignSelf: "flex-start",
            background: "transparent",
            border: "1px dashed var(--border)",
            borderRadius: 4,
            color: "var(--text-muted)",
            fontSize: 12,
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          + {t("Add budget")}
        </button>

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
            type="button"
            onClick={() => void handleSave()}
            disabled={submitting}
            style={{
              background: "var(--accent)",
              color: "var(--bg)",
              border: "none",
              borderRadius: 4,
              padding: "6px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: submitting ? "not-allowed" : "pointer",
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {t("Save")}
          </button>
        </div>
      </div>
    </div>
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