"use client";

/**
 * Edit modal for a single HTTP collection (Collections feature).
 *
 * Replaces the prior `window.prompt()` flow so the dialog matches the rest
 * of the HTTP panel UI (close on overlay click + Escape, themed styling,
 * inline error). Edits name only — description is preserved as-is, matching
 * the previous behavior.
 *
 * Visual style follows HttpPanelSaveItemModal: fixed overlay, form element,
 * no focus trap, no portal.
 */

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { Collection } from "@/lib/http-collections-schema";

export interface HttpPanelEditCollectionModalProps {
  collection: Collection;
  onUpdate: (
    id: string,
    patch: { name: string },
  ) => Promise<unknown>;
  onClose: () => void;
}

export function HttpPanelEditCollectionModal({
  collection,
  onUpdate,
  onClose,
}: HttpPanelEditCollectionModalProps) {
  const { t } = useI18n();
  const [name, setName] = useState(collection.name);
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

  const trimmedName = name.trim();
  const canSubmit =
    trimmedName.length > 0 && trimmedName !== collection.name && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onUpdate(collection.id, { name: trimmedName });
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
          <h2
            style={{
              fontSize: 15,
              fontWeight: 700,
              margin: 0,
              color: "var(--text)",
            }}
          >
            {t("Edit collection")}
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

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {t("Name")}
            <span style={{ color: "#ef4444", marginLeft: 2 }}>*</span>
          </span>
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            placeholder={t("New collection name")}
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "6px 8px",
              fontSize: 13,
              color: "var(--text)",
              outline: "none",
              fontFamily: "var(--font-sans)",
            }}
          />
        </label>

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
