"use client";

import { useCallback, useMemo, useState, useRef, useEffect } from "react";
import { useI18n, type Locale } from "@/hooks/useI18n";
import { useTodos, type Todo } from "@/hooks/useTodos";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useContextMenu, type ContextMenuItem } from "@/components/ContextMenu";
import { RichTextEditor } from "@/components/RichTextEditor";
import { DatePicker } from "./DatePicker";
import { extractImagesFromHtml, ImageLightbox } from "./ImageLightbox";
import { TodoDescriptionView } from "./TodoDescriptionView";
import { highlightMatch } from "./HighlightText";

type StatusFilter = "all" | "active" | "done";
type DeadlineFilter = "all" | "overdue" | "today" | "thisWeek" | "thisMonth" | "noDeadline";

type Filters = {
  status: StatusFilter;
  deadline: DeadlineFilter;
  dateRange: { from: number | null; to: number | null };
  tags: string[];
};

type DeadlineTone = "overdue" | "today" | "future";

const DEFAULT_FILTERS: Filters = { status: "all", deadline: "all", dateRange: { from: null, to: null }, tags: [] };

// Persists the user's filter preference across tab close/reopen and page reload.
// Follows the i18n hydration pattern (hooks/useI18n.tsx) — lazy default + useEffect read.
const TODO_FILTERS_STORAGE_KEY = "pi-todo-filters";

const STATUS_VALUES: ReadonlySet<StatusFilter> = new Set(["all", "active", "done"]);
const DEADLINE_VALUES: ReadonlySet<DeadlineFilter> = new Set([
  "all",
  "overdue",
  "today",
  "thisWeek",
  "thisMonth",
  "noDeadline",
]);

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
    const status = STATUS_VALUES.has(o.status as StatusFilter)
      ? (o.status as StatusFilter)
      : DEFAULT_FILTERS.status;
    const deadline = DEADLINE_VALUES.has(o.deadline as DeadlineFilter)
      ? (o.deadline as DeadlineFilter)
      : DEFAULT_FILTERS.deadline;
    const drRaw = o.dateRange as { from?: unknown; to?: unknown } | null;
    const dr = drRaw && typeof drRaw === "object" ? drRaw : null;
    const from = dr && (typeof dr.from === "number" || dr.from === null) ? (dr.from as number | null) : null;
    const to = dr && (typeof dr.to === "number" || dr.to === null) ? (dr.to as number | null) : null;
    const tags = Array.isArray(o.tags) && o.tags.every((t) => typeof t === "string")
      ? (o.tags as string[])
      : [];
    return { status, deadline, dateRange: { from, to }, tags };
  } catch {
    return DEFAULT_FILTERS;
  }
}

// Mirrors lib/todo-store.ts MAX_TAG_LENGTH. Kept in sync by hand; the server is
// the source of truth and rejects anything longer.
const MAX_TAG_LENGTH = 50;

/**
 * Aggregate every tag used across the visible todos, deduped case-insensitively
 * (preserving first-seen casing) and sorted case-insensitively. Used to power
 * the autocomplete suggestions inside TagChips and the filter popover.
 */
function aggregateTags(todos: Todo[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of todos) {
    for (const tag of t.tags) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return out;
}

/**
 * Detect the in-progress `#xxx` token sitting at the cursor. Returns null when
 * the cursor isn't inside a tag trigger (e.g. cursor sits after a space, or no
 * `#` has been typed yet). Used to decide whether the TagPickerPopover should
 * be shown.
 */
function detectActiveTagToken(
  value: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  if (cursor < 1) return null;
  const upTo = value.slice(0, cursor);
  const hashIdx = upTo.lastIndexOf("#", cursor - 1);
  if (hashIdx < 0) return null;
  // Must be at start of input or preceded by whitespace — a `#` inside a word
  // (e.g. "issue#42") is plain text, not a tag trigger.
  if (hashIdx > 0 && !/\s/.test(value.charAt(hashIdx - 1))) return null;
  const after = value.slice(hashIdx + 1, cursor);
  if (/\s/.test(after)) return null;
  return { start: hashIdx, end: cursor, query: after };
}

/**
 * Split raw input into a clean title and a list of tags. Whitespace-separated
 * tokens beginning with `#` (and longer than one character) become tags; the
 * rest becomes the title. Case-insensitive dedupe, first-seen casing kept —
 * matches the server's normalizeTags() in lib/todo-store.ts.
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

const STATUS_FILTER_OPTIONS: { key: StatusFilter; labelKey: string }[] = [
  { key: "all", labelKey: "All" },
  { key: "active", labelKey: "InProgress" },
  { key: "done", labelKey: "Done" },
];

const DEADLINE_FILTER_OPTIONS: { key: DeadlineFilter; labelKey: string }[] = [
  { key: "all", labelKey: "All" },
  { key: "overdue", labelKey: "Overdue" },
  { key: "today", labelKey: "Due today" },
  { key: "thisWeek", labelKey: "This week" },
  { key: "thisMonth", labelKey: "This month" },
  { key: "noDeadline", labelKey: "No deadline" },
];

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatDateForInput(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDeadline(deadline: number, now: number = Date.now(), locale: Locale = "en"): { label: string; tone: DeadlineTone; daysAhead: number } {
  const todayStart = startOfDay(now);
  const todayEnd = todayStart + 24 * 60 * 60 * 1000 - 1;
  const dateLabel = formatDateForInput(deadline);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(deadline));
  const label = `${dateLabel} ${weekday}`;
  if (deadline < todayStart) return { label, tone: "overdue", daysAhead: 0 };
  if (deadline <= todayEnd) return { label, tone: "today", daysAhead: 0 };
  const daysAhead = Math.round((startOfDay(deadline) - todayStart) / (24 * 60 * 60 * 1000));
  return { label, tone: "future", daysAhead };
}

function CalendarIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-hidden
    >
      <rect x="1.5" y="3" width="9" height="8" rx="1" />
      <line x1="1.5" y1="5.5" x2="10.5" y2="5.5" />
      <line x1="4" y1="1.5" x2="4" y2="3.5" />
      <line x1="8" y1="1.5" x2="8" y2="3.5" />
    </svg>
  );
}

export function TodoPanel() {
  const { t } = useI18n();
  const { todos, loading, refresh, addTodo, updateTodo, deleteTodo, toggleDone, exportTodo, renameTag, deleteTag } = useTodos();
  const confirm = useConfirm();
  const toast = useToast();
  const [viewFilters, setViewFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // Hydrate persisted filter preference after mount (SSR-safe: defaults above
  // match what the server renders, then we sync from localStorage).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TODO_FILTERS_STORAGE_KEY);
      setViewFilters(parsePersistedFilters(raw));
    } catch {
      // localStorage unavailable — keep defaults.
    }
  }, []);

  // Single entry point for user-initiated filter changes: updates the view
  // and writes to localStorage. The transient add-flow handlers call
  // setViewFilters directly so they don't overwrite the saved preference.
  const applyFiltersChange = useCallback((next: Filters) => {
    setViewFilters(next);
    try {
      localStorage.setItem(TODO_FILTERS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage unavailable — in-memory state is still updated.
    }
  }, []);

  const filterActive = viewFilters.status !== "all" || viewFilters.deadline !== "all" || viewFilters.dateRange.from != null || viewFilters.dateRange.to != null || viewFilters.tags.length > 0;

  const [now] = useState(() => Date.now());
  const startOfToday = startOfDay(now);
  const startOfTomorrow = startOfToday + 24 * 60 * 60 * 1000;
  // "本周内" = 本周一 ~ 本周日（含今天）。endOfThisWeek 取"下周一 0 点"，
  // 即本周日结束那一刻。使用 ISO 8601：周一为 1，周日为 0。
  const dayOfWeek = new Date(now).getDay();
  const daysToEndOfWeek = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const endOfThisWeek = startOfToday + daysToEndOfWeek * 24 * 60 * 60 * 1000;
  // "本月内" = 本月 1 日 0 点 ~ 下月 1 日 0 点（不含）。
  const nowDate = new Date(now);
  const startOfThisMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1, 0, 0, 0, 0).getTime();
  const endOfThisMonth = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 1, 0, 0, 0, 0).getTime();

  const tagSuggestions = useMemo(() => aggregateTags(todos), [todos]);

  // Per-tag usage count, deduped case-insensitively. Powers the count column
  // in the tag manager popover. Each todo contributes at most one to any
  // given key, which is a defense-in-depth check on top of normalizeTags.
  const tagCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const todo of todos) {
      const seen = new Set<string>();
      for (const tag of todo.tags) {
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        map[key] = (map[key] ?? 0) + 1;
      }
    }
    return map;
  }, [todos]);

  const visible = useMemo(() => {
    const sortKey: keyof Todo = viewFilters.status === "done" ? "completedAt" : "createdAt";
    const wantedTags = viewFilters.tags.length > 0
      ? new Set(viewFilters.tags.map((t) => t.toLowerCase()))
      : null;
    return [...todos]
      .filter((x) => {
        if (viewFilters.status === "active" && x.done) return false;
        if (viewFilters.status === "done" && !x.done) return false;
        switch (viewFilters.deadline) {
          case "all":
            break;
          case "overdue":
            if (x.done || x.deadline === undefined || x.deadline >= startOfToday) return false;
            break;
          case "today":
            if (x.done || x.deadline === undefined || x.deadline < startOfToday || x.deadline >= startOfTomorrow) return false;
            break;
          case "thisWeek":
            if (x.done || x.deadline === undefined || x.deadline < startOfToday || x.deadline >= endOfThisWeek) return false;
            break;
          case "thisMonth":
            if (x.done || x.deadline === undefined || x.deadline < startOfThisMonth || x.deadline >= endOfThisMonth) return false;
            break;
          case "noDeadline":
            if (x.deadline !== undefined) return false;
            break;
        }
        return true;
      })
      .filter((x) => {
        const term = searchTerm.trim().toLowerCase();
        if (!term) return true;
        return x.title.toLowerCase().includes(term) ||
          (x.description ?? "").toLowerCase().includes(term);
      })
      .filter((x) => {
        if (viewFilters.dateRange.from == null && viewFilters.dateRange.to == null) return true;
        if (x.deadline == null) return false;
        if (viewFilters.dateRange.from != null && x.deadline < viewFilters.dateRange.from) return false;
        if (viewFilters.dateRange.to != null && x.deadline > viewFilters.dateRange.to) return false;
        return true;
      })
      .filter((x) => {
        if (!wantedTags) return true;
        return x.tags.some((t) => wantedTags.has(t.toLowerCase()));
      })
      .sort((a, b) => {
        if (viewFilters.status === "all" && a.done !== b.done) {
          return a.done ? 1 : -1; // active first, done last
        }
        const av = (a[sortKey] as number | undefined) ?? 0;
        const bv = (b[sortKey] as number | undefined) ?? 0;
        return bv - av;
      });
  }, [todos, viewFilters, searchTerm, startOfToday, startOfTomorrow, endOfThisWeek, startOfThisMonth, endOfThisMonth]);

  const handleCreate = async (input: { title: string; tags?: string[] }): Promise<boolean> => {
    const trimmed = input.title.trim();
    if (trimmed.length === 0) return false;
    const todo = await addTodo(trimmed, { tags: input.tags });
    if (todo) {
      // Make the new todo visible — matches the legacy DraftRow flow. Also
      // clear the deadline preset since new todos default to today and would
      // otherwise be hidden by filters like "No deadline" or "Overdue".
      setViewFilters((f) => ({ ...f, status: "active", deadline: "all" }));
      return true;
    }
    return false;
  };

  const handleDelete = async (todo: Todo) => {
    const ok = await confirm({
      title: t("Delete todo?"),
      description: todo.title,
      confirmLabel: t("Delete"),
      destructive: true,
    });
    if (ok) deleteTodo(todo.id);
  };

  // Tag-level handlers. The server returns { tag, affected } and we refresh
  // the local list there; here we just surface the success toast and (for
  // delete) scrub the tag out of the active filter so it doesn't silently
  // become a no-op filter.
  const handleRenameTag = async (from: string, to: string) => {
    const result = await renameTag(from, to);
    if (result) {
      toast.show({ kind: "success", message: t("Tag renamed") });
      // If `from` was in the active filter, swap the entry so the filtered
      // list stays consistent. Comparison is case-insensitive, matching
      // listTodos and the client filter eval.
      if (viewFilters.tags.some((x) => x.toLowerCase() === from.toLowerCase())) {
        const nextTags = viewFilters.tags.map((x) =>
          x.toLowerCase() === from.toLowerCase() ? result.tag : x
        );
        applyFiltersChange({ ...viewFilters, tags: nextTags });
      }
    }
  };

  const handleDeleteTag = async (tag: string) => {
    const result = await deleteTag(tag);
    if (result) {
      toast.show({ kind: "success", message: t("Tag deleted") });
      // Drop the deleted tag from the active filter (case-insensitive match)
      // so the filter doesn't silently become empty.
      const lower = tag.toLowerCase();
      if (viewFilters.tags.some((x) => x.toLowerCase() === lower)) {
        applyFiltersChange({
          ...viewFilters,
          tags: viewFilters.tags.filter((x) => x.toLowerCase() !== lower),
        });
      }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)" }}>
      <FilterBar
        filters={viewFilters}
        onFiltersChange={applyFiltersChange}
        filterOpen={filterOpen}
        onFilterOpenChange={setFilterOpen}
        filterActive={filterActive}
        onCreate={handleCreate}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        tagSuggestions={tagSuggestions}
        tagCounts={tagCounts}
        onRenameTag={handleRenameTag}
        onDeleteTag={handleDeleteTag}
        onRefresh={refresh}
        refreshing={loading}
      />
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px" }}>
        {loading && todos.length === 0 && (
          <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
            {t("Loading...")}
          </div>
        )}
        {!loading && visible.length === 0 && (
          <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
            {searchTerm.trim() ? t("No matches") : t("No todos")}
          </div>
        )}
        {visible.map((todo) => (
          <TodoItem
            key={todo.id}
            todo={todo}
            onToggleDone={() => toggleDone(todo.id)}
            onUpdate={(patch) => updateTodo(todo.id, patch)}
            onDelete={() => handleDelete(todo)}
            onExport={() => exportTodo(todo.id)}
            searchTerm={searchTerm}
            tagSuggestions={tagSuggestions}
          />
        ))}
      </div>
    </div>
  );
}

function FilterBar({
  filters,
  onFiltersChange,
  filterOpen,
  onFilterOpenChange,
  filterActive,
  onCreate,
  searchTerm,
  onSearchChange,
  tagSuggestions,
  tagCounts,
  onRenameTag,
  onDeleteTag,
  onRefresh,
  refreshing,
}: {
  filters: Filters;
  onFiltersChange: (next: Filters) => void;
  filterOpen: boolean;
  onFilterOpenChange: (open: boolean) => void;
  filterActive: boolean;
  onCreate: (input: { title: string; tags?: string[] }) => Promise<boolean>;
  searchTerm: string;
  onSearchChange: (v: string) => void;
  tagSuggestions: string[];
  tagCounts: Record<string, number>;
  onRenameTag: (from: string, to: string) => Promise<void>;
  onDeleteTag: (tag: string) => Promise<void>;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { t } = useI18n();
  const [agentToolsOpen, setAgentToolsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const searchActive = searchTerm.trim().length > 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
      <CreateTodoInput onCreate={onCreate} tagSuggestions={tagSuggestions} />
      <button
        onClick={onRefresh}
        disabled={refreshing}
        aria-label={t("Refresh")}
        title={t("Refresh")}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 22, height: 22, padding: 0,
          flexShrink: 0,
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: 4,
          cursor: refreshing ? "default" : "pointer",
          color: "var(--text-muted)",
          fontFamily: "inherit",
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            animation: refreshing ? "spin 0.8s linear infinite" : undefined,
          }}
        >
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      </button>
      <div style={{ position: "relative", flexShrink: 0 }}>
        <button
          onClick={() => setAgentToolsOpen(!agentToolsOpen)}
          aria-haspopup="dialog"
          aria-expanded={agentToolsOpen}
          aria-label={t("Agent tools settings")}
          title={t("Agent tools settings")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, padding: 0,
            flexShrink: 0,
            background: agentToolsOpen ? "var(--bg-selected)" : "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            cursor: "pointer",
            color: agentToolsOpen ? "var(--text)" : "var(--text-muted)",
            fontFamily: "inherit",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="5.5" cy="5.5" r="1.7" />
            <path d="M5.5 1.5v1.3M5.5 8.2v1.3M1.5 5.5h1.3M8.2 5.5h1.3M2.7 2.7l.9.9M7.4 7.4l.9.9M2.7 8.3l.9-.9M7.4 3.6l.9-.9" />
          </svg>
        </button>
        {agentToolsOpen && (
          <AgentToolsPopover onClose={() => setAgentToolsOpen(false)} />
        )}
      </div>
      <div style={{ position: "relative", flexShrink: 0 }}>
        <button
          onClick={() => onFilterOpenChange(!filterOpen)}
          aria-haspopup="dialog"
          aria-expanded={filterOpen}
          aria-label={t("Filter")}
          title={t("Filter")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, padding: 0,
            flexShrink: 0,
            background: filterActive || filterOpen ? "var(--bg-selected)" : "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            cursor: "pointer",
            color: filterActive || filterOpen ? "var(--text)" : "var(--text-muted)",
            transition: "background 0.1s, color 0.1s",
            fontFamily: "inherit",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polygon points="1,1.5 9,1.5 6.2,5.2 6.2,8.5 3.8,8.5 3.8,5.2" />
          </svg>
        </button>
        {filterOpen && (
          <FilterPopover
            filters={filters}
            onChange={onFiltersChange}
            onClose={() => onFilterOpenChange(false)}
            tagSuggestions={tagSuggestions}
          />
        )}
      </div>
      <div style={{ position: "relative", flexShrink: 0 }}>
        <button
          onClick={() => setTagsOpen(!tagsOpen)}
          aria-haspopup="dialog"
          aria-expanded={tagsOpen}
          aria-label={t("Manage tags")}
          title={t("Manage tags")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, padding: 0,
            flexShrink: 0,
            background: tagsOpen ? "var(--bg-selected)" : "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            cursor: "pointer",
            color: tagsOpen ? "var(--text)" : "var(--text-muted)",
            transition: "background 0.1s, color 0.1s",
            fontFamily: "inherit",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M8.5 1.5 H3 a1.5 1.5 0 0 0 -1.5 1.5 v5.5 a1.5 1.5 0 0 0 1.5 1.5 h5.5 a1.5 1.5 0 0 0 1.5 -1.5 V3.5 z" />
            <circle cx="4" cy="6" r="0.9" fill="currentColor" />
          </svg>
        </button>
        {tagsOpen && (
          <TagManagerPopover
            onClose={() => setTagsOpen(false)}
            tagSuggestions={tagSuggestions}
            tagCounts={tagCounts}
            onRename={onRenameTag}
            onDelete={onDeleteTag}
          />
        )}
      </div>
      <div style={{ position: "relative", flexShrink: 0 }}>
        <button
          onClick={() => setSearchOpen(!searchOpen)}
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          aria-label={t("Search")}
          title={t("Search")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, padding: 0,
            flexShrink: 0,
            background: searchActive || searchOpen ? "var(--bg-selected)" : "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            cursor: "pointer",
            color: searchActive || searchOpen ? "var(--text)" : "var(--text-muted)",
            transition: "background 0.1s, color 0.1s",
            fontFamily: "inherit",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="4.5" cy="4.5" r="2.5" />
            <line x1="6.5" y1="6.5" x2="9" y2="9" />
          </svg>
        </button>
        {searchOpen && (
          <SearchPopover
            value={searchTerm}
            onChange={onSearchChange}
            onClose={() => setSearchOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function CreateTodoInput({
  onCreate,
  tagSuggestions,
}: {
  onCreate: (input: { title: string; tags?: string[] }) => Promise<boolean>;
  tagSuggestions: string[];
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [value, setValue] = useState("");
  const [selectionStart, setSelectionStart] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dropdownDismissed, setDropdownDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Detect an in-progress `#xxx` token at the cursor. Null when the cursor
  // isn't inside a tag trigger (e.g. cursor sits after a space, or no `#`).
  const activeToken = useMemo(
    () => detectActiveTagToken(value, selectionStart),
    [value, selectionStart],
  );

  // Suggestions + optional "Create" row. Sorted case-insensitively; the
  // create row is only shown when the query is non-empty and doesn't already
  // match an existing tag case-insensitively.
  const dropdownItems = useMemo<
    Array<{ kind: "existing"; tag: string } | { kind: "create"; tag: string }>
  >(() => {
    if (!activeToken) return [];
    const q = activeToken.query.toLowerCase();
    const existing = tagSuggestions
      .filter((tg) => tg.toLowerCase().startsWith(q))
      .map((tag) => ({ kind: "existing" as const, tag }));
    if (activeToken.query.length === 0) return existing;
    const hasExact = existing.some((it) => it.tag.toLowerCase() === q);
    if (hasExact) return existing;
    return [...existing, { kind: "create" as const, tag: activeToken.query }];
  }, [activeToken, tagSuggestions]);

  // When the token opens (or its contents change) snap the highlight back to
  // the first row so ArrowDown feels predictable.
  useEffect(() => {
    setActiveIndex(0);
  }, [activeToken?.start, activeToken?.query, dropdownItems.length]);

  // Escape dismissing the dropdown applies to the current token only — once
  // the cursor leaves the token (e.g. user types a space), re-arming lets the
  // next `#` reopen the popover without ceremony.
  useEffect(() => {
    if (!activeToken) setDropdownDismissed(false);
  }, [activeToken]);

  const dropdownOpen = activeToken !== null && !dropdownDismissed && dropdownItems.length > 0;

  const commitTag = (tag: string) => {
    if (!activeToken) return;
    if (tag.length > MAX_TAG_LENGTH) {
      toast.show({ kind: "error", message: t("Tag is too long") });
      return;
    }
    // Replace the `#xxx` token with `#<tag> ` (trailing space jumps the cursor
    // out of the tag zone so further typing lands in the title).
    const next = value.slice(0, activeToken.start) + `#${tag} ` + value.slice(activeToken.end);
    const newCursor = activeToken.start + 1 + tag.length + 1;
    setValue(next);
    setSelectionStart(newCursor);
    setActiveIndex(0);
    setDropdownDismissed(false);
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(newCursor, newCursor);
      }
    });
  };

  const submit = async () => {
    if (submitting) return;
    const parsed = parseCreateInput(value);
    if (parsed.title.length === 0) {
      toast.show({ kind: "error", message: t("Title cannot be empty") });
      return;
    }
    for (const tg of parsed.tags) {
      if (tg.length > MAX_TAG_LENGTH) {
        toast.show({ kind: "error", message: t("Tag is too long") });
        return;
      }
    }
    setSubmitting(true);
    try {
      const ok = await onCreate(parsed);
      // Only clear on success — failed creates leave the value for retry.
      if (ok) {
        setValue("");
        setSelectionStart(0);
      }
    } finally {
      setSubmitting(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 6px",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        position: "relative",
      }}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
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
        placeholder={t("# to add tags")}
        aria-label={t("# to add tags")}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (dropdownOpen) {
              const item = dropdownItems[activeIndex];
              if (item) commitTag(item.tag);
            } else {
              void submit();
            }
          } else if (e.key === "Escape") {
            if (dropdownOpen) {
              e.preventDefault();
              setDropdownDismissed(true);
            } else if (value.length > 0) {
              e.preventDefault();
              setValue("");
              setSelectionStart(0);
            }
          } else if (e.key === "ArrowDown" && dropdownOpen) {
            e.preventDefault();
            setActiveIndex((i) => (i + 1) % dropdownItems.length);
          } else if (e.key === "ArrowUp" && dropdownOpen) {
            e.preventDefault();
            setActiveIndex((i) => (i - 1 + dropdownItems.length) % dropdownItems.length);
          } else if (e.key === "Tab" && dropdownOpen) {
            e.preventDefault();
            const item = dropdownItems[activeIndex];
            if (item) commitTag(item.tag);
          }
        }}
        style={{
          flex: 1,
          minWidth: 0,
          padding: "3px 0",
          fontSize: 11,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--text)",
          fontFamily: "inherit",
        }}
      />
      {dropdownOpen && (
        <TagPickerPopover
          items={dropdownItems}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onSelect={(i) => {
            const item = dropdownItems[i];
            if (item) commitTag(item.tag);
          }}
          onMouseDownOutside={() => setDropdownDismissed(true)}
        />
      )}
    </div>
  );
}

/**
 * Suggestion list anchored beneath CreateTodoInput. Lists matching existing
 * tags plus an optional "Create tag #xxx" row when the typed query doesn't
 * collide. Mouse and keyboard interactions are owned by the parent so the
 * input keeps focus and cursor placement authority.
 */
function TagPickerPopover({
  items,
  activeIndex,
  onHover,
  onSelect,
  onMouseDownOutside,
}: {
  items: Array<{ kind: "existing" | "create"; tag: string }>;
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  onMouseDownOutside: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onMouseDownOutside();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onMouseDownOutside]);

  return (
    <div
      ref={ref}
      role="listbox"
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        left: 0,
        right: 0,
        zIndex: 10,
        maxHeight: 200,
        overflowY: "auto",
        padding: 4,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
      }}
    >
      {items.map((item, i) => {
        const isActive = i === activeIndex;
        const isCreate = item.kind === "create";
        return (
          <div
            key={`${item.kind}-${item.tag}`}
            role="option"
            aria-selected={isActive}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              // mousedown (not click) so the input's blur doesn't dismiss the
              // popover before our handler runs.
              e.preventDefault();
              onSelect(i);
            }}
            style={{
              padding: "4px 8px",
              fontSize: 11,
              cursor: "pointer",
              background: isActive ? "var(--bg-selected)" : "transparent",
              color: isCreate ? "var(--text-muted)" : "var(--text)",
              borderLeft: isCreate ? "2px dashed var(--border)" : "2px solid transparent",
              display: "flex",
              alignItems: "center",
              gap: 6,
              borderRadius: 3,
            }}
          >
            {isCreate ? (
              <span>{t("Create tag #{tag}").replace("{tag}", item.tag)}</span>
            ) : (
              <>
                <span style={{ color: "var(--text-dim)" }}>#</span>
                <span>{item.tag}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SearchPopover({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("Search")}
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        right: 0,
        zIndex: 10,
        minWidth: 220,
        padding: 6,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
        display: "flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
        <circle cx="4.5" cy="4.5" r="2.5" />
        <line x1="6.5" y1="6.5" x2="9" y2="9" />
      </svg>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("Search todos…")}
        style={{
          flex: 1,
          minWidth: 0,
          padding: "2px 0",
          fontSize: 11,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--text)",
          fontFamily: "inherit",
        }}
      />
      {value.length > 0 && (
        <button
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          aria-label={t("Clear search")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 14,
            height: 14,
            padding: 0,
            flexShrink: 0,
            background: "transparent",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
          }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="1" y1="1" x2="7" y2="7" />
            <line x1="7" y1="1" x2="1" y2="7" />
          </svg>
        </button>
      )}
    </div>
  );
}

function FilterPopover({
  filters,
  onChange,
  onClose,
  tagSuggestions,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  onClose: () => void;
  tagSuggestions: string[];
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const reset = () => onChange(DEFAULT_FILTERS);

  const toggleTag = (tag: string) => {
    const key = tag.toLowerCase();
    const next = filters.tags.some((t) => t.toLowerCase() === key)
      ? filters.tags.filter((t) => t.toLowerCase() !== key)
      : [...filters.tags, tag];
    onChange({ ...filters, tags: next });
  };

  const renderOption = <K extends string>(
    options: { key: K; labelKey: string }[],
    current: K,
    onSelect: (key: K) => void,
  ) => (
    <div role="radiogroup" style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {options.map((o) => {
        const selected = current === o.key;
        return (
          <button
            key={o.key}
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(o.key)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "4px 8px",
              fontSize: 11,
              textAlign: "left",
              background: selected ? "var(--bg-selected)" : "transparent",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              color: selected ? "var(--text)" : "var(--text-muted)",
              fontFamily: "inherit",
            }}
          >
            <span
              aria-hidden
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 10, height: 10, flexShrink: 0,
                border: `1.2px solid ${selected ? "var(--accent)" : "var(--text-dim)"}`,
                borderRadius: "50%",
              }}
            >
              {selected && (
                <span style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--accent)" }} />
              )}
            </span>
            {t(o.labelKey)}
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("Filter")}
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        right: 0,
        zIndex: 10,
        minWidth: 168,
        padding: 6,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 8px 4px", textTransform: "uppercase", letterSpacing: 0.5 }}>
          {t("Status")}
        </div>
        {renderOption(STATUS_FILTER_OPTIONS, filters.status, (key) =>
          onChange({ ...filters, status: key as StatusFilter }),
        )}
      </div>
      <div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 8px 4px", textTransform: "uppercase", letterSpacing: 0.5 }}>
          {t("Deadline")}
        </div>
        {renderOption(DEADLINE_FILTER_OPTIONS, filters.deadline, (key) =>
          onChange({
            ...filters,
            deadline: key as DeadlineFilter,
            // Custom date range is mutually exclusive with the deadline preset —
            // selecting any non-"all" preset clears the range.
            dateRange: key === "all" ? filters.dateRange : { from: null, to: null },
          }),
        )}
      </div>
      <div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 8px 4px", textTransform: "uppercase", letterSpacing: 0.5 }}>
          {t("Date range")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "2px 8px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
            <span style={{ width: 36, flexShrink: 0 }}>{t("From")}</span>
            <DatePicker
              value={filters.dateRange.from}
              onChange={(ts) => {
                onChange({
                  ...filters,
                  dateRange: {
                    from: ts,
                    to: filters.dateRange.to,
                  },
                  // Selecting a range clears the deadline preset.
                  deadline: ts != null ? "all" : filters.deadline,
                });
              }}
              ariaLabel={t("From")}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
            <span style={{ width: 36, flexShrink: 0 }}>{t("To")}</span>
            <DatePicker
              value={filters.dateRange.to}
              onChange={(ts) => {
                // DatePicker emits start-of-day; bump to end-of-day so the
                // "To" upper bound is inclusive of the picked day.
                const next =
                  ts != null
                    ? new Date(new Date(ts).setHours(23, 59, 59, 999)).getTime()
                    : null;
                onChange({
                  ...filters,
                  dateRange: {
                    from: filters.dateRange.from,
                    to: next,
                  },
                  deadline: next != null ? "all" : filters.deadline,
                });
              }}
              ariaLabel={t("To")}
            />
          </label>
          {(filters.dateRange.from != null || filters.dateRange.to != null) && (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => onChange({ ...filters, dateRange: { from: null, to: null } })}
                style={{
                  padding: "2px 8px",
                  fontSize: 11,
                  background: "transparent",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {t("Clear range")}
              </button>
            </div>
          )}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 8px 4px", textTransform: "uppercase", letterSpacing: 0.5 }}>
          {t("Filter by tags")}
        </div>
        {tagSuggestions.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "4px 8px" }}>
            {t("No tags")}
          </div>
        ) : (
          <div role="group" style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {tagSuggestions.map((tag) => {
              const checked = filters.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
              return (
                <button
                  key={tag}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggleTag(tag)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "4px 8px",
                    fontSize: 11,
                    textAlign: "left",
                    background: checked ? "var(--bg-selected)" : "transparent",
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    color: checked ? "var(--text)" : "var(--text-muted)",
                    fontFamily: "inherit",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      width: 10, height: 10, flexShrink: 0,
                      border: `1.2px solid ${checked ? "var(--accent)" : "var(--text-dim)"}`,
                      borderRadius: 2,
                      background: checked ? "var(--accent)" : "transparent",
                      color: "var(--bg)",
                    }}
                  >
                    {checked && (
                      <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="2 5 4.5 7.5 8.5 2.5" />
                      </svg>
                    )}
                  </span>
                  {tag}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 6, display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={reset}
          style={{
            padding: "2px 8px",
            fontSize: 11,
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {t("Reset filters")}
        </button>
      </div>
    </div>
  );
}

const TOOL_KEYS = ["todo_list", "todo_create", "todo_update", "todo_delete"] as const;

function AgentToolsPopover({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const ref = useRef<HTMLDivElement | null>(null);
  const [enabled, setEnabled] = useState<Set<string> | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set(TOOL_KEYS));
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/todo-tools")
      .then((r) => r.json())
      .then((data: { enabled?: string[] }) => {
        if (cancelled) return;
        const list = Array.isArray(data.enabled) ? data.enabled : [...TOOL_KEYS];
        setEnabled(new Set(list));
        setDraft(new Set(list));
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setEnabled(new Set(TOOL_KEYS));
        setDraft(new Set(TOOL_KEYS));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const toggle = (name: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const dirty = enabled !== null && (() => {
    if (draft.size !== enabled.size) return true;
    for (const k of draft) if (!enabled.has(k)) return true;
    return false;
  })();

  const onSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/todo-tools", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: [...draft] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { enabled: string[] };
      setEnabled(new Set(data.enabled));
      setDraft(new Set(data.enabled));
      toast.show({ kind: "success", message: t("Saved") });
      onClose();
    } catch {
      toast.show({ kind: "error", message: t("Save failed") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("Pi agent tools")}
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        right: 0,
        zIndex: 10,
        minWidth: 200,
        padding: 6,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 8px 4px", textTransform: "uppercase", letterSpacing: 0.5 }}>
        {t("Pi agent tools")}
      </div>
      <div role="group" style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {TOOL_KEYS.map((name) => {
          const checked = draft.has(name);
          return (
            <label
              key={name}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "4px 8px",
                fontSize: 11,
                background: checked ? "var(--bg-selected)" : "transparent",
                borderRadius: 4,
                cursor: "pointer",
                color: checked ? "var(--text)" : "var(--text-muted)",
                fontFamily: "inherit",
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(name)}
                disabled={!loaded || saving}
                style={{ margin: 0, cursor: "pointer" }}
              />
              {t(`Tool: ${name}`)}
            </label>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 8px 0" }}>
        {t("Applies to new sessions")}
      </div>
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 6, display: "flex", justifyContent: "flex-end", gap: 4 }}>
        <button
          onClick={onClose}
          style={{
            padding: "2px 8px",
            fontSize: 11,
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {t("Close")}
        </button>
        <button
          onClick={onSave}
          disabled={!loaded || !dirty || saving}
          style={{
            padding: "2px 10px",
            fontSize: 11,
            background: !loaded || !dirty || saving ? "var(--bg)" : "var(--accent)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: !loaded || !dirty || saving ? "var(--text-dim)" : "var(--bg)",
            cursor: !loaded || !dirty || saving ? "not-allowed" : "pointer",
            fontWeight: 500,
            fontFamily: "inherit",
          }}
        >
          {t("Save")}
        </button>
      </div>
    </div>
  );
}

// Truncate a tag name for display in the (narrow) popover rows. The full
// string is still passed to the server; a `title=` attribute shows the
// complete value on hover.
function truncateTag(s: string, n = 24): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function TagManagerPopover({
  onClose,
  tagSuggestions,
  tagCounts,
  onRename,
  onDelete,
}: {
  onClose: () => void;
  tagSuggestions: string[];
  tagCounts: Record<string, number>;
  onRename: (from: string, to: string) => Promise<void>;
  onDelete: (tag: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const ref = useRef<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const startRename = (tag: string) => {
    setEditing(tag);
    setDraft(tag);
  };

  const cancelRename = () => {
    setEditing(null);
    setDraft("");
  };

  const commitRename = async () => {
    if (!editing) return;
    const next = draft.trim();
    // No-op rename (same string, or empty draft) — just exit edit mode.
    if (next.length === 0 || next.toLowerCase() === editing.toLowerCase()) {
      cancelRename();
      return;
    }
    setBusy(true);
    try {
      await onRename(editing, next);
      setEditing(null);
      setDraft("");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (tag: string) => {
    const count = tagCounts[tag.toLowerCase()] ?? 0;
    const ok = await confirm({
      title: t("Delete tag?"),
      description: count === 1
        ? t("Delete tag from {n} todo?").replace("{n}", String(count))
        : t("Delete tag from {n} todos?").replace("{n}", String(count)),
      confirmLabel: t("Delete"),
      destructive: true,
    });
    if (ok) await onDelete(tag);
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("Manage tags")}
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        right: 0,
        zIndex: 10,
        minWidth: 220,
        maxWidth: 280,
        padding: 6,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 8px 4px", textTransform: "uppercase", letterSpacing: 0.5 }}>
        {t("Manage tags")}
      </div>
      {tagSuggestions.length === 0 && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "6px 8px" }}>
          {t("No tags")}
        </div>
      )}
      <div role="group" style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 240, overflowY: "auto" }}>
        {tagSuggestions.map((tag) => {
          const count = tagCounts[tag.toLowerCase()] ?? 0;
          const isEditing = editing === tag;
          if (isEditing) {
            return (
              <div
                key={tag}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "2px 6px",
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  disabled={busy}
                  aria-label={t("New tag name")}
                  style={{
                    flex: 1, minWidth: 0,
                    padding: "2px 4px",
                    fontSize: 11,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 3,
                    color: "var(--text)",
                    fontFamily: "inherit",
                    outline: "none",
                  }}
                />
                <button
                  onClick={commitRename}
                  disabled={busy}
                  style={{
                    padding: "2px 6px", fontSize: 10,
                    background: "transparent",
                    border: "none",
                    color: busy ? "var(--text-dim)" : "var(--text-muted)",
                    cursor: busy ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  {t("Save")}
                </button>
                <button
                  onClick={cancelRename}
                  disabled={busy}
                  style={{
                    padding: "2px 6px", fontSize: 10,
                    background: "transparent",
                    border: "none",
                    color: busy ? "var(--text-dim)" : "var(--text-muted)",
                    cursor: busy ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  {t("Cancel")}
                </button>
              </div>
            );
          }
          return (
            <div
              key={tag}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "3px 8px",
                fontSize: 11,
                borderRadius: 4,
                fontFamily: "inherit",
              }}
            >
              <span
                title={tag}
                style={{
                  flex: 1, minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--text)",
                }}
              >
                {truncateTag(tag)}
              </span>
              <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>
                · {count}
              </span>
              <button
                onClick={() => startRename(tag)}
                disabled={busy}
                style={{
                  padding: "0 4px", fontSize: 10,
                  background: "transparent",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: busy ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--text)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)"; }}
              >
                {t("Rename tag")}
              </button>
              <button
                onClick={() => handleDelete(tag)}
                disabled={busy}
                style={{
                  padding: "0 4px", fontSize: 10,
                  background: "transparent",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: busy ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#f87171"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)"; }}
              >
                {t("Delete tag")}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TagChips({
  tags,
  editable,
  suggestions,
  onChange,
  placeholder,
}: {
  tags: string[];
  editable: boolean;
  suggestions?: string[];
  onChange?: (next: string[]) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Returns true if the tag was added (caller should clear the input). False
  // means rejected (empty / duplicate / too long); input is left as-is so the
  // user can correct it.
  const tryAdd = (raw: string): boolean => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return false;
    if (trimmed.length > MAX_TAG_LENGTH) {
      toast.show({ kind: "error", message: t("Tag is too long") });
      return false;
    }
    const key = trimmed.toLowerCase();
    if (tags.some((tg) => tg.toLowerCase() === key)) {
      toast.show({ kind: "error", message: t("Tag already added") });
      return false;
    }
    onChange?.([...tags, trimmed]);
    return true;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (tryAdd(draft)) setDraft("");
    } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
      e.preventDefault();
      onChange?.(tags.slice(0, -1));
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft("");
      inputRef.current?.blur();
    }
  };

  const handleBlur = () => {
    setFocused(false);
    if (tryAdd(draft)) setDraft("");
    else if (draft.trim().length > 0) setDraft("");
  };

  const removeAt = (idx: number) => {
    onChange?.(tags.filter((_, i) => i !== idx));
  };

  // Show suggestions only when focused, and only tags not already attached.
  // Filter by current input (case-insensitive substring) so it doubles as
  // autocomplete while typing.
  const termKey = draft.trim().toLowerCase();
  const visibleSuggestions = focused && suggestions
    ? suggestions.filter((s) => {
        const k = s.toLowerCase();
        if (tags.some((tg) => tg.toLowerCase() === k)) return false;
        if (termKey && !k.includes(termKey)) return false;
        return true;
      }).slice(0, 8)
    : [];

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {tags.map((tg, i) => (
          <span
            key={`${tg}-${i}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 2,
              padding: "1px 4px 1px 8px",
              fontSize: 11,
              background: "var(--bg-hover)",
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              lineHeight: 1.5,
            }}
          >
            {tg}
            {editable && (
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={t("Remove tag")}
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 14, height: 14, padding: 0,
                  background: "transparent",
                  border: "none",
                  borderRadius: 7,
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
              >
                <svg width="7" height="7" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="1" y1="1" x2="7" y2="7" />
                  <line x1="7" y1="1" x2="1" y2="7" />
                </svg>
              </button>
            )}
          </span>
        ))}
        {editable && (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={handleBlur}
            placeholder={tags.length === 0 ? placeholder : ""}
            style={{
              flex: 1, minWidth: 60,
              padding: "1px 4px",
              fontSize: 11,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--text)",
              fontFamily: "inherit",
            }}
          />
        )}
      </div>
      {visibleSuggestions.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 2px)",
            left: 0,
            zIndex: 5,
            minWidth: 120,
            maxHeight: 160,
            overflowY: "auto",
            padding: 2,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
            display: "flex",
            flexDirection: "column",
            gap: 1,
          }}
        >
          {visibleSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              // mousedown (not click) so the input's blur doesn't fire first
              // and wipe the draft before our handler runs.
              onMouseDown={(e) => { e.preventDefault(); if (tryAdd(s)) setDraft(""); }}
              style={{
                padding: "3px 8px",
                fontSize: 11,
                textAlign: "left",
                background: "transparent",
                border: "none",
                borderRadius: 3,
                cursor: "pointer",
                color: "var(--text-muted)",
                fontFamily: "inherit",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TodoItem({
  todo,
  onToggleDone,
  onUpdate,
  onDelete,
  onExport,
  searchTerm,
  tagSuggestions,
}: {
  todo: Todo;
  onToggleDone: () => void;
  onUpdate: (patch: { title?: string; description?: string; done?: boolean; deadline?: number; tags?: string[] }) => void;
  onDelete: () => void;
  onExport: () => Promise<void>;
  searchTerm: string;
  tagSuggestions: string[];
}) {
  const { t } = useI18n();
  const toast = useToast();
  const cm = useContextMenu();
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [detailsVisible, setDetailsVisible] = useState(!todo.done);
  const [titleDraft, setTitleDraft] = useState(todo.title);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [deadlinePickerOpen, setDeadlinePickerOpen] = useState(false);

  const openDeadlinePicker = () => setDeadlinePickerOpen(true);

  // Gallery of every image reference in the description, for lightbox
  // prev/next navigation. Scans the Tiptap-emitted HTML (not legacy markdown)
  // — see `extractImagesFromHtml` in components/ImageLightbox.tsx. Todo image
  // URLs are already absolute (/api/todo-images/...) so the view passes
  // identity for the resolveSrc callback.
  const gallery = useMemo(
    () => extractImagesFromHtml(todo.description ?? ""),
    [todo.description],
  );

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      {
        key: "rename",
        label: t("Rename"),
        onSelect: () => {
          setTitleDraft(todo.title);
          setEditingTitle(true);
        },
      },
      {
        key: "set-deadline",
        label: todo.deadline !== undefined ? t("Change deadline") : t("Set deadline"),
        onSelect: openDeadlinePicker,
      },
      ...(todo.deadline !== undefined
        ? [{
            key: "clear-deadline",
            label: t("Clear deadline"),
            onSelect: () => onUpdate({ deadline: undefined }),
          }]
        : []),
      {
        key: "export",
        label: t("Export as zip"),
        onSelect: () => {
          onExport().catch((e) =>
            toast.show({ kind: "error", message: t("Export failed") + ": " + String(e) }),
          );
        },
      },
      {
        key: "delete",
        label: t("Delete"),
        destructive: true,
        onSelect: () => { onDelete(); },
      },
    ];
    cm.open({ x: e.clientX, y: e.clientY, items });
  };

  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed.length === 0) {
      toast.show({ kind: "error", message: t("Title cannot be empty") });
      setTitleDraft(todo.title);
      setEditingTitle(false);
      return;
    }
    if (trimmed !== todo.title) {
      onUpdate({ title: trimmed });
    }
    setEditingTitle(false);
  };

  const commitDescription = (value: string) => {
    if (value !== (todo.description ?? "")) {
      onUpdate({ description: value });
    }
    setEditingDesc(false);
  };

  const commitTags = (next: string[]) => {
    const same = next.length === todo.tags.length
      && next.every((t, i) => t === todo.tags[i]);
    if (!same) onUpdate({ tags: next });
  };

  return (
    <div
      onContextMenu={handleContextMenu}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 6px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={onToggleDone}
          aria-label={t("Toggle done")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 14, height: 14, flexShrink: 0,
            background: todo.done ? "var(--accent)" : "transparent",
            border: `1.5px solid ${todo.done ? "var(--accent)" : "var(--text-dim)"}`,
            borderRadius: 3,
            cursor: "pointer",
            padding: 0,
            color: "var(--bg)",
            transition: "background 0.1s, border-color 0.1s",
          }}
        >
          {todo.done && (
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2 5 4.5 7.5 8.5 2.5" />
            </svg>
          )}
        </button>
        <span
          aria-hidden="true"
          style={{
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 10,
            height: 10,
            color: "var(--text-dim)",
            transform: detailsVisible ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.1s",
          }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2.5 1.5 5.5 4 2.5 6.5" />
          </svg>
        </span>
        {editingTitle ? (
          <input
            value={titleDraft}
            autoFocus
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitTitle(); }
              else if (e.key === "Escape") { e.preventDefault(); setTitleDraft(todo.title); setEditingTitle(false); }
            }}
            onBlur={commitTitle}
            style={{
              flex: 1, minWidth: 0,
              padding: "2px 4px",
              fontSize: 13, fontWeight: 500,
              background: "var(--bg-selected)",
              border: "1px solid var(--accent)",
              borderRadius: 3,
              outline: "none",
              color: "var(--text)",
              fontFamily: "inherit",
            }}
          />
        ) : (
          <span
            onClick={() => setDetailsVisible((v) => !v)}
            onDoubleClick={() => { setTitleDraft(todo.title); setEditingTitle(true); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setDetailsVisible((v) => !v);
              }
            }}
            role="button"
            tabIndex={editingTitle ? -1 : 0}
            aria-expanded={detailsVisible}
            style={{
              flex: 1, minWidth: 0,
              fontSize: 13, fontWeight: 500,
              color: todo.done ? "var(--text-muted)" : "var(--accent)",
              textDecoration: todo.done ? "line-through" : "none",
              cursor: "pointer",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {highlightMatch(todo.title, searchTerm)}
          </span>
        )}
        <DeadlineControl
          todo={todo}
          open={deadlinePickerOpen}
          onOpenChange={setDeadlinePickerOpen}
          onChange={(v) => onUpdate({ deadline: v })}
        />
      </div>
      {detailsVisible && (todo.tags.length > 0 || !todo.done) ? (
        <div style={{ marginLeft: 22 }}>
          <TagChips
            editable={!todo.done}
            tags={todo.tags}
            onChange={commitTags}
            suggestions={tagSuggestions}
            placeholder={t("Add tag…")}
          />
        </div>
      ) : null}
      {detailsVisible && (editingDesc && !todo.done ? (
        <RichTextEditor
          defaultValue={todo.description ?? ""}
          onSave={commitDescription}
          onCancel={() => setEditingDesc(false)}
          placeholder={t("Add description...")}
        />
      ) : (
        <div style={{ marginLeft: 22 }}>
          <div
            onDoubleClick={todo.done ? undefined : () => setEditingDesc(true)}
            style={{
              minHeight: 18,
              fontSize: 12,
              lineHeight: 1.5,
              color: todo.done ? "var(--text-dim)" : "var(--text-muted)",
              textDecoration: todo.done ? "line-through" : "none",
              textDecorationColor: todo.done ? "var(--text-muted)" : undefined,
              cursor: todo.done ? "default" : "text",
              padding: "2px 0",
            }}
          >
            {todo.description ? (
              <TodoDescriptionView
                html={todo.description}
                searchTerm={searchTerm}
                onImageClick={(src) => {
                  const idx = gallery.findIndex((g) => g.src === src);
                  if (idx >= 0) setLightboxIndex(idx);
                }}
              />
            ) : (
              <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>{t("Add description...")}</span>
            )}
          </div>
        </div>
      ))}
      {lightboxIndex !== null && gallery.length > 0 && !todo.done && (
        <ImageLightbox
          images={gallery}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
        />
      )}
    </div>
  );
}

function DeadlineControl({
  todo,
  open,
  onOpenChange,
  onChange,
}: {
  todo: Todo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (v: number | undefined) => void;
}) {
  const { t, locale } = useI18n();

  if (todo.deadline === undefined) {
    return (
      <DatePicker
        value={null}
        onChange={(ts) => {
          if (ts == null) return;
          // Bump to end-of-day so the deadline flips at midnight local time
          // the day after.
          onChange(new Date(new Date(ts).setHours(23, 59, 59, 999)).getTime());
        }}
        open={open}
        onOpenChange={onOpenChange}
        ariaLabel={t("Set deadline")}
        renderTrigger={({ open: isOpen, ref, onClick }) => (
          <button
            ref={ref}
            onClick={onClick}
            aria-label={t("Set deadline")}
            title={t("Set deadline")}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 20, height: 20, padding: 0,
              flexShrink: 0,
              background: "transparent",
              border: "none",
              color: isOpen ? "var(--text)" : "var(--text-dim)",
              cursor: "pointer",
              borderRadius: 3,
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = isOpen ? "var(--text)" : "var(--text-dim)")}
          >
            <CalendarIcon />
          </button>
        )}
      />
    );
  }

  const { label, tone, daysAhead } = formatDeadline(todo.deadline, Date.now(), locale);
  const color = todo.done
    ? "var(--text-dim)"
    : tone === "overdue" ? "#ef4444" : tone === "today" ? "var(--accent)" : "#f97316";
  const suffix = todo.done
    ? ""
    : tone === "overdue" ? ` (${t("Overdue")})`
    : tone === "today"   ? ` (${t("Due today")})`
    : ` (${t("In {n} days").replace("{n}", String(daysAhead))})`;
  return (
    <DatePicker
      value={todo.deadline}
      onChange={(ts) => {
        if (ts == null) {
          onChange(undefined);
          return;
        }
        onChange(new Date(new Date(ts).setHours(23, 59, 59, 999)).getTime());
      }}
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={t("Change deadline")}
      renderTrigger={({ open: isOpen, ref, onClick }) => (
        <button
          ref={ref}
          onClick={onClick}
          aria-label={t("Change deadline")}
          title={t("Change deadline")}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "1px 6px", fontSize: 11,
            flexShrink: 0,
            background: "transparent",
            border: "none",
            color: isOpen ? "var(--text)" : color,
            cursor: "pointer",
            borderRadius: 3,
            fontFamily: "inherit",
            textDecoration: todo.done ? "line-through" : "none",
          }}
          onMouseEnter={(e) => { if (!todo.done) e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = isOpen ? "var(--text)" : color; }}
        >
          <CalendarIcon /> {label}{suffix}
        </button>
      )}
    />
  );
}
