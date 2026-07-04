"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { useConfirm } from "./ConfirmDialog";
import type { CategoryWithCount } from "@/hooks/useFinance";

interface FinanceCategoryManagerProps {
  categories: CategoryWithCount[];
  onCreate: (name: string) => Promise<void>;
  onRename: (oldName: string, newName: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onClose: () => void;
}

interface DraftRow {
  id: string; // local row id, distinct from server name
  mode: "existing" | "new" | "editing";
  originalName: string | null; // set for existing + editing
  value: string;
}

let _draftCounter = 0;
function nextDraftId(): string {
  _draftCounter += 1;
  return `draft-${Date.now()}-${_draftCounter}`;
}

export function FinanceCategoryManager({
  categories,
  onCreate,
  onRename,
  onDelete,
  onClose,
}: FinanceCategoryManagerProps) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const [rows, setRows] = useState<DraftRow[]>(() =>
    categories.map((c) => ({
      id: nextDraftId(),
      mode: "existing" as const,
      originalName: c.name,
      value: c.name,
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

  const handleAddNew = () => {
    setRows((prev) => [
      ...prev,
      { id: nextDraftId(), mode: "new", originalName: null, value: "" },
    ]);
  };

  const handleChangeValue = (id: string, value: string) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        if (r.mode === "existing") {
          return { ...r, mode: "editing", value };
        }
        return { ...r, value };
      }),
    );
  };

  const handleRemoveRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  // Reconcile local drafts against the server snapshot when categories
  // change (e.g. after a refetch from a sibling mutation). Existing rows
  // stay; new server categories get appended; rows deleted upstream are
  // dropped from the draft list.
  useEffect(() => {
    setRows((prev) => {
      const serverNames = new Set(categories.map((c) => c.name));
      // Keep local rows that don't have a server name (edits + new).
      const kept = prev.filter(
        (r) => r.mode !== "existing" || (r.originalName && serverNames.has(r.originalName)),
      );
      const knownNames = new Set(
        kept.map((r) => (r.mode === "new" ? r.value.trim() : r.originalName)).filter(Boolean),
      );
      const additions: DraftRow[] = categories
        .filter((c) => !knownNames.has(c.name))
        .map((c) => ({
          id: nextDraftId(),
          mode: "existing" as const,
          originalName: c.name,
          value: c.name,
        }));
      return [...kept, ...additions];
    });
  }, [categories]);

  const handleDeleteExisting = async (row: DraftRow) => {
    if (!row.originalName) return;
    const count = categories.find((c) => c.name === row.originalName)?.count ?? 0;
    const ok = await confirm({
      title: t("Delete category?"),
      description:
        count > 0
          ? t("Delete category {name}? {count} transactions keep this name in their history.")
              .replace("{name}", row.originalName)
              .replace("{count}", String(count))
          : t("Delete category {name}?").replace("{name}", row.originalName),
      confirmLabel: t("Delete"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await onDelete(row.originalName);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      toast.show({ kind: "success", message: t("Category deleted") });
    } catch (e) {
      toast.show({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const aName = (a.originalName ?? a.value).trim();
      const bName = (b.originalName ?? b.value).trim();
      return aName.localeCompare(bName);
    });
    return copy;
  }, [rows]);

  const handleSave = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const trimmed = new Set<string>();
      for (const r of sortedRows) {
        const v = r.value.trim();
        if (!v) continue;
        if (r.mode === "new") {
          await onCreate(v);
          trimmed.add(v);
        } else if (r.mode === "editing" && r.originalName && r.originalName !== v) {
          await onRename(r.originalName, v);
          trimmed.add(v);
        } else {
          // unchanged
          trimmed.add(r.originalName ?? v);
        }
      }
      // Rows that were removed from the draft (i.e. user removed an "existing" row)
      // need a server delete — but we already handled explicit delete via the trash
      // button, so "removal" via the − button is also a delete.
      const finalNames = new Set<string>();
      for (const r of sortedRows) {
        const v = r.value.trim();
        if (!v) continue;
        finalNames.add(v);
      }
      for (const c of categories) {
        if (!finalNames.has(c.name)) {
          await onDelete(c.name);
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
            {t("Categories")}
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
            gridTemplateColumns: "1fr 60px 32px 32px",
            gap: 6,
            fontSize: 11,
            color: "var(--text-muted)",
            padding: "0 4px",
          }}
        >
          <span>{t("Name")}</span>
          <span style={{ textAlign: "right" }}>{t("Used")}</span>
          <span />
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
          {sortedRows.length === 0 && (
            <div
              style={{
                padding: 16,
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: 12,
              }}
            >
              {t("No categories yet — add one below")}
            </div>
          )}
          {sortedRows.map((row) => {
            const meta = categories.find((c) => c.name === row.originalName);
            const count = meta?.count ?? 0;
            // Orphan categories (used in transactions but never registered in
            // the categories table) cannot be deleted — DELETE would 404
            // because there's no row to remove. Disable the button and
            // surface the constraint so users know how to clean up.
            const isOrphan = row.originalName !== null && (meta?.createdAt ?? 0) === 0;
            const dirty = row.mode === "editing" || row.mode === "new";
            return (
              <div
                key={row.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 60px 32px 32px",
                  gap: 6,
                  alignItems: "center",
                }}
              >
                <input
                  type="text"
                  value={row.value}
                  onChange={(e) => handleChangeValue(row.id, e.target.value)}
                  placeholder={t("Category name")}
                  style={{
                    ...inputStyle,
                    borderColor: dirty ? "var(--accent)" : "var(--border)",
                  }}
                />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--text-muted)",
                    textAlign: "right",
                  }}
                >
                  {count}
                </span>
                {row.mode === "new" ? (
                  <button
                    type="button"
                    onClick={() => handleRemoveRow(row.id)}
                    aria-label={t("Discard")}
                    title={t("Discard")}
                    style={iconButtonStyle}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="4" y1="4" x2="12" y2="12" />
                      <line x1="12" y1="4" x2="4" y2="12" />
                    </svg>
                  </button>
                ) : (
                  <span />
                )}
                {row.mode === "existing" || row.mode === "editing" ? (
                  <button
                    type="button"
                    onClick={() => void handleDeleteExisting(row)}
                    aria-label={isOrphan ? t("Orphan category — cannot be deleted") : t("Delete")}
                    title={isOrphan ? t("This category comes from existing transactions. Delete those transactions first, then remove the category.") : t("Delete")}
                    disabled={isOrphan}
                    style={{
                      ...iconButtonStyle,
                      opacity: isOrphan ? 0.35 : 1,
                      cursor: isOrphan ? "not-allowed" : "pointer",
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 4h10M6 4V2.5h4V4M5 4l1 9h4l1-9" />
                    </svg>
                  </button>
                ) : (
                  <span />
                )}
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={handleAddNew}
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
          + {t("Add category")}
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
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            borderTop: "1px solid var(--border)",
            paddingTop: 10,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {t("Renaming a category updates all linked transactions.")}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
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