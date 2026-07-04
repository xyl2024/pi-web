"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useNotes, type Note, type Tag } from "@/hooks/useNotes";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useContextMenu, type ContextMenuItem } from "@/components/ContextMenu";
import { RichTextEditor } from "@/components/RichTextEditor";
import { TodoDescriptionView } from "./TodoDescriptionView";
import { TAG_COLOR_PRESETS, tagContrastText } from "@/lib/todo-color-presets";
import { uploadNoteImages } from "@/lib/note-image-upload";

type Filters = {
  tags: string[];
};

const DEFAULT_FILTERS: Filters = { tags: [] };

// Persists the user's tag-filter preference across tab close/reopen and page
// reload. Search term stays in-memory (intentionally — a sticky search would
// hide newly-created notes).
const NOTES_FILTERS_STORAGE_KEY = "pi-notes-filters";

/**
 * Read and validate a persisted Filters object from localStorage. Falls back to
 * DEFAULT_FILTERS for any field that doesn't match the expected shape so a
 * corrupt or stale entry can never crash the panel.
 */
function parsePersistedFilters(raw: string | null): Filters {
  if (!raw) return DEFAULT_FILTERS;
  try {
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return DEFAULT_FILTERS;
    const o = obj as Record<string, unknown>;
    const tags = Array.isArray(o.tags) && o.tags.every((t) => typeof t === "string")
      ? (o.tags as string[])
      : [];
    return { tags };
  } catch {
    return DEFAULT_FILTERS;
  }
}

/**
 * Aggregate every tag used across the visible notes, deduped case-insensitively
 * (preserving first-seen casing + color) and sorted case-insensitively. Powers
 * the autocomplete suggestions inside TagChips and the filter popover.
 */
function aggregateTags(notes: Note[]): Tag[] {
  const seen = new Map<string, Tag>();
  for (const n of notes) {
    for (const tag of n.tags) {
      const key = tag.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.set(key, tag);
    }
  }
  const out = [...seen.values()];
  out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return out;
}

/**
 * Detect the in-progress `#xxx` token sitting at the cursor. Returns null when
 * the cursor isn't inside a tag trigger. Used to decide whether the
 * TagPickerPopover should be shown.
 */
function detectActiveTagToken(
  value: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  if (cursor < 1) return null;
  const upTo = value.slice(0, cursor);
  const hashIdx = upTo.lastIndexOf("#", cursor - 1);
  if (hashIdx < 0) return null;
  if (hashIdx > 0 && !/\s/.test(value.charAt(hashIdx - 1))) return null;
  const after = value.slice(hashIdx + 1, cursor);
  if (/\s/.test(after)) return null;
  return { start: hashIdx, end: cursor, query: after };
}

/**
 * Split raw input into a clean title and a list of tags. Whitespace-separated
 * tokens beginning with `#` (and longer than one character) become tags; the
 * rest becomes the title. Matches the server's normalizeTags() in
 * lib/notes-store.ts.
 */
function parseCreateInput(value: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  const titleTokens: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(/\s+/)) {
    if (!raw) continue;
    if (raw.startsWith("#") && raw.length > 1) {
      const tag = raw.slice(1).trim();
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    } else {
      titleTokens.push(raw);
    }
  }
  return { title: titleTokens.join(" ").trim(), tags };
}

// ---------------------------------------------------------------------------
// Notes panel root
// ---------------------------------------------------------------------------

export function NotesPanel() {
  const { t } = useI18n();
  const { notes, loading, refresh, addNote, updateNote, deleteNote, renameTag, deleteTag, setTagColor } = useNotes();
  const confirm = useConfirm();
  const toast = useToast();
  const [viewFilters, setViewFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Auto-select the newest note whenever the list grows. Used to back the
  // global ⌘N shortcut: AppShell creates a note, then this effect selects it
  // (and enters edit mode) so the user lands in the new note immediately.
  // Refs track the previous count so this only fires on additions, not on the
  // first mount with existing data — a fresh panel opening onto existing
  // notes shouldn't auto-focus one.
  const lastNoteCountRef = useRef(0);
  useEffect(() => {
    if (notes.length > lastNoteCountRef.current) {
      const newest = notes[0];
      setSelectedId(newest.id);
      setEditingId(newest.id);
    }
    lastNoteCountRef.current = notes.length;
  }, [notes]);

  // Hydrate persisted filter preference after mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(NOTES_FILTERS_STORAGE_KEY);
      setViewFilters(parsePersistedFilters(raw));
    } catch {
      // localStorage unavailable — keep defaults.
    }
  }, []);

  const applyFiltersChange = useCallback((next: Filters) => {
    setViewFilters(next);
    try {
      localStorage.setItem(NOTES_FILTERS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage unavailable — in-memory state is still updated.
    }
  }, []);

  const filterActive = viewFilters.tags.length > 0;

  const tagSuggestions = useMemo(() => aggregateTags(notes), [notes]);

  const tagCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const note of notes) {
      const seen = new Set<string>();
      for (const tag of note.tags) {
        const key = tag.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        map[key] = (map[key] ?? 0) + 1;
      }
    }
    return map;
  }, [notes]);

  const visible = useMemo(() => {
    const wantedTags = viewFilters.tags.length > 0
      ? new Set(viewFilters.tags.map((t) => t.toLowerCase()))
      : null;
    return [...notes]
      .filter((x) => {
        const term = searchTerm.trim().toLowerCase();
        if (!term) return true;
        return x.title.toLowerCase().includes(term) ||
          x.content.toLowerCase().includes(term);
      })
      .filter((x) => {
        if (!wantedTags) return true;
        return x.tags.some((t) => wantedTags.has(t.name.toLowerCase()));
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [notes, viewFilters, searchTerm]);

  const handleCreate = useCallback(async (input: { title: string; tags?: string[] }): Promise<boolean> => {
    const tags: Tag[] | undefined = input.tags?.map((name) => {
      const existing = tagSuggestions.find((s) => s.name.toLowerCase() === name.toLowerCase());
      return { name, color: existing?.color };
    });
    const note = await addNote(input.title, { tags });
    if (note) {
      setSelectedId(note.id);
      setEditingId(note.id);
      return true;
    }
    return false;
  }, [addNote, tagSuggestions]);

  const handleDelete = useCallback(async (note: Note) => {
    const ok = await confirm({
      title: t("Delete note?"),
      description: note.title,
      confirmLabel: t("Delete"),
      destructive: true,
    });
    if (!ok) return;
    const wasSelected = selectedId === note.id;
    await deleteNote(note.id);
    if (wasSelected) setSelectedId(null);
  }, [confirm, t, deleteNote, selectedId]);

  const handleSetTagColor = useCallback(async (tag: string, color: string | null) => {
    await setTagColor(tag, color);
  }, [setTagColor]);

  const handleRenameTag = useCallback(async (from: string, to: string) => {
    const result = await renameTag(from, to);
    if (result) {
      toast.show({ kind: "success", message: t("Tag renamed") });
      if (viewFilters.tags.some((x) => x.toLowerCase() === from.toLowerCase())) {
        const nextTags = viewFilters.tags.map((x) =>
          x.toLowerCase() === from.toLowerCase() ? result.tag : x
        );
        applyFiltersChange({ ...viewFilters, tags: nextTags });
      }
    }
  }, [renameTag, toast, t, viewFilters, applyFiltersChange]);

  const handleDeleteTag = useCallback(async (tag: string) => {
    const result = await deleteTag(tag);
    if (result) {
      toast.show({ kind: "success", message: t("Tag deleted") });
      const lower = tag.toLowerCase();
      if (viewFilters.tags.some((x) => x.toLowerCase() === lower)) {
        applyFiltersChange({
          ...viewFilters,
          tags: viewFilters.tags.filter((x) => x.toLowerCase() !== lower),
        });
      }
    }
  }, [deleteTag, toast, t, viewFilters, applyFiltersChange]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)" }}>
      <FilterBar
        onCreate={handleCreate}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        tagSuggestions={tagSuggestions}
        tagCounts={tagCounts}
        onRenameTag={handleRenameTag}
        onDeleteTag={handleDeleteTag}
        onSetTagColor={handleSetTagColor}
        onRefresh={refresh}
        refreshing={loading}
        viewFilters={viewFilters}
        onFiltersChange={applyFiltersChange}
        filterActive={filterActive}
      />
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px" }}>
        {loading && notes.length === 0 && (
          <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
            {t("Loading...")}
          </div>
        )}
        {!loading && notes.length === 0 && (
          <EmptyState onCreate={handleCreate} />
        )}
        {!loading && notes.length > 0 && visible.length === 0 && (
          <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
            {searchTerm.trim() || filterActive ? t("No matches") : t("No notes yet")}
          </div>
        )}
        {visible.map((note) => (
          <NoteItem
            key={note.id}
            note={note}
            selected={selectedId === note.id}
            onSelect={() => setSelectedId(note.id)}
            editing={editingId === note.id}
            onEditStart={() => setEditingId(note.id)}
            onEditEnd={() => setEditingId(null)}
            onUpdate={(patch) => updateNote(note.id, patch)}
            onDelete={() => handleDelete(note)}
            searchTerm={searchTerm}
            tagSuggestions={tagSuggestions}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onCreate }: { onCreate: (input: { title: string; tags?: string[] }) => Promise<boolean> }) {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeToken, setActiveToken] = useState<{ start: number; end: number; query: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleInputChange = (v: string) => {
    setInput(v);
    const cursor = inputRef.current?.selectionStart ?? v.length;
    setActiveToken(detectActiveTagToken(v, cursor));
  };

  const handleSubmit = async () => {
    const parsed = parseCreateInput(input);
    const ok = await onCreate({ title: parsed.title, tags: parsed.tags.length > 0 ? parsed.tags : undefined });
    if (ok) {
      setInput("");
      setActiveToken(null);
    }
  };

  return (
    <div
      style={{
        margin: "32px 16px",
        padding: "32px 16px",
        borderRadius: 10,
        border: "1.5px dashed var(--border)",
        textAlign: "center",
        color: "var(--text-muted)",
      }}
    >
      <div style={{ fontSize: 14, marginBottom: 6, color: "var(--text)" }}>{t("No notes yet")}</div>
      <div style={{ fontSize: 12, marginBottom: 16 }}>{t("Create your first note")}</div>
      <div style={{ display: "flex", gap: 6, maxWidth: 360, margin: "0 auto" }}>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
          placeholder={t("Title (or #tag)...")}
          style={{
            flex: 1,
            padding: "6px 10px",
            fontSize: 13,
            background: "var(--bg-panel)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            outline: "none",
          }}
        />
        <button
          onClick={() => void handleSubmit()}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            background: "var(--accent)",
            color: "var(--text-on-accent, #fff)",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          {t("Create")}
        </button>
      </div>
      {showSuggestions && activeToken && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-dim)" }}>
          {t("Press Enter to create")} <code style={{ background: "var(--bg-panel)", padding: "0 4px", borderRadius: 3 }}>#{activeToken.query}</code>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar (New note + search + tag filter + tag manager)
// ---------------------------------------------------------------------------

interface FilterBarProps {
  onCreate: (input: { title: string; tags?: string[] }) => Promise<boolean>;
  searchTerm: string;
  onSearchChange: (v: string) => void;
  tagSuggestions: Tag[];
  tagCounts: Record<string, number>;
  onRenameTag: (from: string, to: string) => Promise<void>;
  onDeleteTag: (tag: string) => Promise<void>;
  onSetTagColor: (tag: string, color: string | null) => Promise<void>;
  onRefresh: () => Promise<void>;
  refreshing: boolean;
  viewFilters: Filters;
  onFiltersChange: (next: Filters) => void;
  filterActive: boolean;
}

function FilterBar({
  onCreate,
  searchTerm,
  onSearchChange,
  tagSuggestions,
  tagCounts,
  onRenameTag,
  onDeleteTag,
  onSetTagColor,
  onRefresh,
  refreshing,
  viewFilters,
  onFiltersChange,
  filterActive,
}: FilterBarProps) {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [activeToken, setActiveToken] = useState<{ start: number; end: number; query: string } | null>(null);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tagBtnRef = useRef<HTMLButtonElement | null>(null);

  const handleInputChange = (v: string) => {
    setInput(v);
    const cursor = inputRef.current?.selectionStart ?? v.length;
    setActiveToken(detectActiveTagToken(v, cursor));
  };

  const handleSubmit = async () => {
    const parsed = parseCreateInput(input);
    const ok = await onCreate({ title: parsed.title, tags: parsed.tags.length > 0 ? parsed.tags : undefined });
    if (ok) {
      setInput("");
      setActiveToken(null);
      inputRef.current?.focus();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => handleInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void handleSubmit();
          }
        }}
        placeholder={t("New note (Title #tag)...")}
        style={{
          flex: 1,
          padding: "5px 9px",
          fontSize: 12,
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 5,
          outline: "none",
        }}
      />
      {activeToken && (
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>#{activeToken.query}</span>
      )}
      <button
        onClick={onRefresh}
        disabled={refreshing}
        title={t("Refresh")}
        style={iconButtonStyle}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 8a6 6 0 0 1 10.3-4.2M14 8a6 6 0 0 1-10.3 4.2" />
          <path d="M12 1.5v3h-3M4 14.5v-3h3" />
        </svg>
      </button>
      <input
        type="search"
        value={searchTerm}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={t("Search notes...")}
        style={{
          width: 130,
          padding: "5px 8px",
          fontSize: 12,
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 5,
          outline: "none",
        }}
      />
      <button
        ref={tagBtnRef}
        onClick={() => setTagMenuOpen((o) => !o)}
        title={t("Filter by tag")}
        style={{
          ...iconButtonStyle,
          background: filterActive ? "var(--accent)" : undefined,
          color: filterActive ? "var(--text-on-accent, #fff)" : undefined,
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 2h6l6 6-6 6-6-6z" />
          <circle cx="5" cy="5" r="0.8" fill="currentColor" />
        </svg>
      </button>
      {tagMenuOpen && (
        <TagFilterPopover
          anchorRef={tagBtnRef}
          available={tagSuggestions}
          counts={tagCounts}
          selected={viewFilters.tags}
          onChange={(next) => onFiltersChange({ tags: next })}
          onClose={() => setTagMenuOpen(false)}
          onRename={onRenameTag}
          onDelete={onDeleteTag}
          onSetColor={onSetTagColor}
        />
      )}
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 26,
  padding: 0,
  background: "transparent",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  cursor: "pointer",
  flexShrink: 0,
};

// ---------------------------------------------------------------------------
// Tag filter popover (anchored to the filter button)
// ---------------------------------------------------------------------------

function TagFilterPopover({
  anchorRef,
  available,
  counts,
  selected,
  onChange,
  onClose,
  onRename,
  onDelete,
  onSetColor,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  available: Tag[];
  counts: Record<string, number>;
  selected: string[];
  onChange: (next: string[]) => void;
  onClose: () => void;
  onRename: (from: string, to: string) => Promise<void>;
  onDelete: (tag: string) => Promise<void>;
  onSetColor: (tag: string, color: string | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: r.right, bottom: window.innerHeight - r.top + 4 });
  }, [anchorRef]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [anchorRef, onClose]);

  const toggle = (name: string) => {
    const lower = name.toLowerCase();
    if (selected.some((s) => s.toLowerCase() === lower)) {
      onChange(selected.filter((s) => s.toLowerCase() !== lower));
    } else {
      onChange([...selected, name]);
    }
  };

  if (!pos) return null;

  return (
    <div
      ref={popRef}
      style={{
        position: "fixed",
        left: pos.left,
        bottom: pos.bottom,
        transform: "translateX(-100%)",
        width: 260,
        maxHeight: 320,
        overflowY: "auto",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        padding: 6,
        zIndex: 1000,
      }}
    >
      <div style={{ fontSize: 10, padding: "4px 8px", color: "var(--text-dim)", textTransform: "uppercase" }}>
        {t("Filter by tag")}
      </div>
      {available.length === 0 && (
        <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-dim)" }}>
          {t("No tags yet")}
        </div>
      )}
      {available.map((tag) => {
        const lower = tag.name.toLowerCase();
        const isSelected = selected.some((s) => s.toLowerCase() === lower);
        const count = counts[lower] ?? 0;
        return (
          <div
            key={tag.name}
            onClick={() => toggle(tag.name)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 8px",
              fontSize: 12,
              borderRadius: 4,
              cursor: "pointer",
              background: isSelected ? "var(--bg-selected)" : "transparent",
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: tag.color ?? "var(--text-dim)",
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, color: tag.color ? tagContrastText(tag.color) : "var(--text)" }}>#{tag.name}</span>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{count}</span>
          </div>
        );
      })}
      {available.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 6 }}>
          <TagManagerSection tags={available} counts={counts} onRename={onRename} onDelete={onDelete} onSetColor={onSetColor} />
        </div>
      )}
    </div>
  );
}

function TagManagerSection({
  tags,
  counts,
  onRename,
  onDelete,
  onSetColor,
}: {
  tags: Tag[];
  counts: Record<string, number>;
  onRename: (from: string, to: string) => Promise<void>;
  onDelete: (tag: string) => Promise<void>;
  onSetColor: (tag: string, color: string | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary style={{ fontSize: 10, padding: "4px 8px", color: "var(--text-dim)", cursor: "pointer", textTransform: "uppercase", userSelect: "none" }}>
        {t("Manage tags")}
      </summary>
      <div style={{ padding: "4px 0" }}>
        {tags.map((tag) => (
          <TagManagerRow
            key={tag.name}
            tag={tag}
            count={counts[tag.name.toLowerCase()] ?? 0}
            onRename={onRename}
            onDelete={onDelete}
            onSetColor={onSetColor}
          />
        ))}
      </div>
    </details>
  );
}

function TagManagerRow({
  tag,
  count,
  onRename,
  onDelete,
  onSetColor,
}: {
  tag: Tag;
  count: number;
  onRename: (from: string, to: string) => Promise<void>;
  onDelete: (tag: string) => Promise<void>;
  onSetColor: (tag: string, color: string | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag.name);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);

  const handleRename = async () => {
    const next = draft.trim();
    if (next === tag.name || next.length === 0) {
      setEditing(false);
      setDraft(tag.name);
      return;
    }
    await onRename(tag.name, next);
    setEditing(false);
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: t("Delete tag?"),
      description: `#${tag.name} (${count} ${t("notes")})`,
      confirmLabel: t("Delete"),
      destructive: true,
    });
    if (ok) await onDelete(tag.name);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        fontSize: 11,
      }}
    >
      <button
        onClick={() => setColorPickerOpen((o) => !o)}
        title={t("Set color")}
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: tag.color ?? "var(--text-dim)",
          border: "1px solid var(--border)",
          padding: 0,
          cursor: "pointer",
        }}
      />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleRename();
            } else if (e.key === "Escape") {
              setEditing(false);
              setDraft(tag.name);
            }
          }}
          onBlur={() => void handleRename()}
          style={{
            flex: 1,
            padding: "1px 4px",
            fontSize: 11,
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--accent)",
            borderRadius: 3,
            outline: "none",
          }}
        />
      ) : (
        <span
          onDoubleClick={() => setEditing(true)}
          style={{ flex: 1, cursor: "text", color: "var(--text)" }}
          title={t("Double-click to rename")}
        >
          #{tag.name}
        </span>
      )}
      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{count}</span>
      <button
        onClick={handleDelete}
        title={t("Delete")}
        style={{
          background: "transparent",
          color: "var(--text-dim)",
          border: "none",
          cursor: "pointer",
          padding: "0 4px",
          fontSize: 12,
        }}
      >
        ×
      </button>
      {colorPickerOpen && (
        <div
          onMouseLeave={() => setColorPickerOpen(false)}
          style={{
            position: "absolute",
            display: "grid",
            gridTemplateColumns: "repeat(8, 1fr)",
            gap: 3,
            padding: 4,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            zIndex: 1001,
          }}
        >
          {TAG_COLOR_PRESETS.map((c) => (
            <button
              key={c}
              onClick={() => {
                void onSetColor(tag.name, c);
                setColorPickerOpen(false);
              }}
              title={c}
              style={{
                width: 14,
                height: 14,
                borderRadius: 3,
                background: c,
                border: tag.color?.toLowerCase() === c.toLowerCase() ? "2px solid var(--text)" : "1px solid var(--border)",
                cursor: "pointer",
                padding: 0,
              }}
            />
          ))}
          <button
            onClick={() => {
              void onSetColor(tag.name, null);
              setColorPickerOpen(false);
            }}
            title={t("Clear color")}
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              background: "transparent",
              border: "1px dashed var(--border)",
              cursor: "pointer",
              padding: 0,
            }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single note row
// ---------------------------------------------------------------------------

function NoteItem({
  note,
  selected,
  onSelect,
  editing,
  onEditStart,
  onEditEnd,
  onUpdate,
  onDelete,
  searchTerm,
  tagSuggestions,
}: {
  note: Note;
  selected: boolean;
  onSelect: () => void;
  editing: boolean;
  onEditStart: () => void;
  onEditEnd: () => void;
  onUpdate: (patch: { title?: string; content?: string; tags?: Tag[] }) => Promise<void>;
  onDelete: () => Promise<void> | void;
  searchTerm: string;
  tagSuggestions: Tag[];
}) {
  const { t } = useI18n();
  const contextMenu = useContextMenu();
  const [titleDraft, setTitleDraft] = useState(note.title);
  const [tagDraft, setTagDraft] = useState<Tag[]>(note.tags);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  // Keep titleDraft in sync if the note's title changes externally (e.g. via
  // refresh, or another tab in the panel).
  useEffect(() => {
    if (!editing) setTitleDraft(note.title);
  }, [note.title, editing]);

  useEffect(() => {
    if (!editing) setTagDraft(note.tags);
  }, [note.tags, editing]);

  const handleTitleSave = useCallback(() => {
    const next = titleDraft.trim();
    if (next === note.title) return;
    if (next.length === 0) {
      setTitleDraft(note.title);
      return;
    }
    void onUpdate({ title: next });
  }, [titleDraft, note.title, onUpdate]);

  const handleTitleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      setTitleDraft(note.title);
      (e.target as HTMLInputElement).blur();
    }
  };

  const handleTagsSave = useCallback((next: Tag[]) => {
    setTagDraft(next);
    void onUpdate({ tags: next });
  }, [onUpdate]);

  const handleContentSave = useCallback((html: string) => {
    if (html === note.content) return;
    void onUpdate({ content: html });
  }, [note.content, onUpdate]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const items: ContextMenuItem[] = [
      { key: "delete", label: t("Delete"), onSelect: () => void onDelete(), destructive: true },
    ];
    contextMenu.open({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <div
      onClick={onSelect}
      onContextMenu={handleContextMenu}
      style={{
        padding: "8px 10px",
        margin: "4px 0",
        borderRadius: 6,
        background: selected ? "var(--bg-selected)" : "var(--bg-panel)",
        border: "1px solid " + (selected ? "var(--accent)" : "var(--border)"),
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          ref={titleInputRef}
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onFocus={onEditStart}
          onBlur={() => { handleTitleSave(); onEditEnd(); }}
          onKeyDown={handleTitleKey}
          onClick={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            padding: "2px 4px",
            fontSize: 13,
            fontWeight: 500,
            background: "transparent",
            color: "var(--text)",
            border: "none",
            outline: "none",
          }}
        />
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
          {formatDate(note.createdAt)}
        </span>
      </div>
      <TagChips
        tags={tagDraft}
        suggestions={tagSuggestions}
        onChange={handleTagsSave}
      />
      {selected && (
        <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 6 }}>
          {editing ? (
            <RichTextEditor
              key={`editor-${note.id}-${editing ? "on" : "off"}`}
              defaultValue={note.content}
              onSave={(html) => { handleContentSave(html); onEditEnd(); }}
              onCancel={() => { onEditEnd(); }}
              placeholder={t("Start writing...")}
              minHeight={120}
              uploadImages={uploadNoteImages}
            />
          ) : (
            <div
              onClick={onEditStart}
              style={{
                minHeight: 24,
                padding: "4px 0",
                cursor: "text",
                color: note.content ? "var(--text)" : "var(--text-dim)",
              }}
            >
              {note.content ? (
                <TodoDescriptionView html={note.content} searchTerm={searchTerm} />
              ) : (
                t("Start writing...")
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Tag chip editor (compact for inline use in NoteItem)
// ---------------------------------------------------------------------------

function TagChips({
  tags,
  suggestions,
  onChange,
}: {
  tags: Tag[];
  suggestions: Tag[];
  onChange: (next: Tag[]) => void;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const handleAdd = (raw: string) => {
    const trimmed = raw.trim().replace(/^#/, "");
    if (trimmed.length === 0) return;
    if (tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) return;
    const existing = suggestions.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
    onChange([...tags, { name: trimmed, color: existing?.color }]);
    setDraft("");
  };

  const handleRemove = (name: string) => {
    onChange(tags.filter((t) => t.name.toLowerCase() !== name.toLowerCase()));
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
      {tags.map((tag) => (
        <span
          key={tag.name}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            padding: "1px 6px",
            fontSize: 10,
            borderRadius: 9,
            background: tag.color ?? "var(--bg-subtle)",
            color: tag.color ? tagContrastText(tag.color) : "var(--text-muted)",
          }}
        >
          #{tag.name}
          <button
            onClick={() => handleRemove(tag.name)}
            style={{
              background: "transparent",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              padding: 0,
              marginLeft: 2,
              fontSize: 11,
              lineHeight: 1,
            }}
            title={t("Remove tag")}
          >
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              handleAdd(draft);
            } else if (e.key === "Escape") {
              setAdding(false);
              setDraft("");
            }
          }}
          onBlur={() => {
            if (draft.trim()) handleAdd(draft);
            setAdding(false);
          }}
          placeholder="#tag"
          style={{
            width: 70,
            padding: "1px 4px",
            fontSize: 10,
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 9,
            outline: "none",
          }}
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          style={{
            background: "transparent",
            color: "var(--text-dim)",
            border: "1px dashed var(--border)",
            borderRadius: 9,
            padding: "1px 6px",
            fontSize: 10,
            cursor: "pointer",
          }}
        >
          + {t("tag")}
        </button>
      )}
    </div>
  );
}