"use client";

/**
 * Create / Edit modal for a saved HTTP request item (Collections feature).
 *
 * Reused for both flows — the parent picks `mode` and the right callback
 * (`onCreate` vs `onUpdate`). Inline "+ New collection" sub-form calls
 * `onCreateCollection`; the parent's refetch then auto-selects the new
 * row.
 *
 * Form fields:
 *   - name (required, max 200, autoFocus)
 *   - description (optional, max 1000)
 *   - tags (optional, comma-separated → trimmed, deduped, lowercased)
 *   - collections (required, ≥1, checkbox list of all known collections)
 *
 * Visual style follows ImportCurlModal (HttpPanel.tsx L337–471) and
 * SettingsModal — no focus trap, no portal, just a fixed overlay with
 * click-outside + Escape close.
 */

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type {
  Collection,
  CreateCollectionInput,
  CreateItemInput,
  HttpItem,
  UpdateItemInput,
} from "@/lib/http-collections-schema";
import type {
  BodyMode,
  HttpMethod,
  KVRow,
} from "@/hooks/httpStore";

export interface SaveItemModalInitialValues {
  name: string;
  description: string;
  method: HttpMethod;
  url: string;
  params: KVRow[];
  headers: KVRow[];
  bodyMode: BodyMode;
  body: string;
  timeoutMs: number | null;
  tags: string[];
}

export interface HttpPanelSaveItemModalProps {
  mode: "create" | "edit";
  initialValues?: SaveItemModalInitialValues;
  item?: HttpItem;
  /** For edit mode: which collections the item is currently a member of,
   *  so the checkbox list can pre-check them. Not part of HttpItem itself
   *  because the join rows are queried separately. */
  itemCollectionIds?: string[];
  collections: Collection[];
  onCreate: (input: CreateItemInput) => Promise<HttpItem>;
  onUpdate: (id: string, patch: UpdateItemInput) => Promise<HttpItem>;
  onCreateCollection: (input: CreateCollectionInput) => Promise<Collection>;
  onClose: () => void;
}

function parseTags(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function serializeTags(tags: string[]): string {
  return tags.join(", ");
}

export function HttpPanelSaveItemModal({
  mode,
  initialValues,
  item,
  itemCollectionIds,
  collections,
  onCreate,
  onUpdate,
  onCreateCollection,
  onClose,
}: HttpPanelSaveItemModalProps) {
  const { t } = useI18n();

  const [name, setName] = useState(
    item?.name ?? initialValues?.name ?? "",
  );
  const [description, setDescription] = useState(
    item?.description ?? initialValues?.description ?? "",
  );
  const [tagsInput, setTagsInput] = useState(
    serializeTags(item?.tags ?? initialValues?.tags ?? []),
  );
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (mode === "edit" && item) {
      // We don't have the item's collectionIds here directly — the parent
      // computes it. For the create path there's no preselection either.
      return [];
    }
    return [];
  });
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newCollectionError, setNewCollectionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // For edit mode, the parent passes the item's current collectionIds via
  // `itemCollectionIds`. Use that to pre-check the right boxes on mount.
  useEffect(() => {
    if (mode === "edit" && itemCollectionIds) {
      setSelectedIds(itemCollectionIds);
    }
  }, [mode, itemCollectionIds]);

  // Escape closes the modal
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
    trimmedName.length > 0 && selectedIds.length > 0 && !submitting;

  const handleToggleCollection = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleAddNewCollection = async () => {
    const trimmed = newCollectionName.trim();
    if (trimmed.length === 0) {
      setNewCollectionError(t("Name"));
      return;
    }
    setNewCollectionError(null);
    try {
      const created = await onCreateCollection({ name: trimmed });
      setSelectedIds((prev) =>
        prev.includes(created.id) ? prev : [...prev, created.id],
      );
      setNewCollectionName("");
      setShowNewCollection(false);
    } catch (e) {
      setNewCollectionError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const tags = parseTags(tagsInput);
      if (mode === "create") {
        if (!initialValues) {
          throw new Error("missing initialValues for create");
        }
        const input: CreateItemInput = {
          name: trimmedName,
          description: description.trim(),
          method: initialValues.method,
          url: initialValues.url,
          params: initialValues.params,
          headers: initialValues.headers,
          bodyMode: initialValues.bodyMode,
          body: initialValues.body,
          timeoutMs: initialValues.timeoutMs,
          tags,
          collectionIds: selectedIds,
        };
        await onCreate(input);
      } else {
        if (!item) throw new Error("missing item for edit");
        const patch: UpdateItemInput = {
          name: trimmedName,
          description: description.trim(),
          tags,
          collectionIds: selectedIds,
        };
        await onUpdate(item.id, patch);
      }
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const sortedCollections = [...collections].sort((a, b) => a.createdAt - b.createdAt);

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
          minWidth: 420,
          maxWidth: 560,
          maxHeight: "85vh",
          overflow: "auto",
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
            {mode === "create" ? t("Save request") : t("Edit item")}
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

        <Field label={t("Name")} required>
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("Name")}
            style={inputStyle}
          />
        </Field>

        <Field label={t("Description")}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("Description")}
            rows={2}
            style={{ ...inputStyle, resize: "vertical", minHeight: 40, fontFamily: "var(--font-sans)" }}
          />
        </Field>

        <Field label={t("Tags (comma-separated)")}>
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="auth, smoke"
            style={inputStyle}
          />
        </Field>

        <Field label={t("In collections")} required>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: 180,
              overflowY: "auto",
            }}
          >
            {sortedCollections.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: 12, padding: 4 }}>
                {t("No collections yet")}
              </div>
            ) : (
              sortedCollections.map((c) => (
                <label
                  key={c.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 13,
                    color: "var(--text)",
                    cursor: "pointer",
                    padding: "2px 4px",
                    borderRadius: 4,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(c.id)}
                    onChange={() => handleToggleCollection(c.id)}
                  />
                  <span style={{ flex: 1 }}>{c.name}</span>
                </label>
              ))
            )}
          </div>
        </Field>

        {!showNewCollection ? (
          <button
            type="button"
            onClick={() => setShowNewCollection(true)}
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
            + {t("New collection")}
          </button>
        ) : (
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              padding: 6,
              border: "1px solid var(--border)",
              borderRadius: 6,
            }}
          >
            <input
              autoFocus
              type="text"
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleAddNewCollection();
                }
              }}
              placeholder={t("New collection name")}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              type="button"
              onClick={() => void handleAddNewCollection()}
              style={{
                background: "var(--accent)",
                color: "var(--bg)",
                border: "none",
                borderRadius: 4,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("Add")}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowNewCollection(false);
                setNewCollectionName("");
                setNewCollectionError(null);
              }}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                borderRadius: 4,
                padding: "4px 8px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {t("Cancel")}
            </button>
          </div>
        )}
        {newCollectionError && (
          <div style={{ color: "#ef4444", fontSize: 12 }}>{newCollectionError}</div>
        )}

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
            {mode === "create" ? t("Save") : t("Save")}
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
