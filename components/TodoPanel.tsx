"use client";

import { useMemo, useState, useRef, useEffect, Fragment, cloneElement, createElement, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "@/hooks/useI18n";
import { useTodos, type Todo } from "@/hooks/useTodos";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useContextMenu, type ContextMenuItem } from "@/components/ContextMenu";
import { MarkdownEditor } from "@/components/MarkdownEditor";

type Filter = "active" | "all" | "done";

type DeadlineTone = "overdue" | "today" | "future";

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfDayFromInput(value: string): number | undefined {
  // <input type="date"> emits "YYYY-MM-DD" in local time. Store as end-of-day so
  // overdue detection flips at midnight local time the day after.
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return d.getTime();
}

function formatDateForInput(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDeadline(deadline: number, now: number = Date.now()): { label: string; tone: DeadlineTone } {
  const todayStart = startOfDay(now);
  const todayEnd = todayStart + 24 * 60 * 60 * 1000 - 1;
  const label = formatDateForInput(deadline);
  if (deadline < todayStart) return { label, tone: "overdue" };
  if (deadline <= todayEnd) return { label, tone: "today" };
  return { label, tone: "future" };
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

function highlightMatch(text: string, term: string): ReactNode {
  if (!term) return text;
  const lower = text.toLowerCase();
  const t = term.toLowerCase();
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(t, i);
    if (idx === -1) break;
    ranges.push([idx, idx + t.length]);
    i = idx + t.length;
  }
  if (!ranges.length) return text;
  const out: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([s, e], k) => {
    if (s > cursor) out.push(text.slice(cursor, s));
    out.push(
      <mark
        key={k}
        style={{ background: "#fde047", color: "#1a1a1a", borderRadius: 2, padding: "0 1px" }}
      >
        {text.slice(s, e)}
      </mark>
    );
    cursor = e;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function highlightDeep(node: ReactNode, term: string): ReactNode {
  if (!term) return node;
  if (node == null || typeof node === "boolean") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "string") return highlightMatch(node, term);
  if (Array.isArray(node)) {
    return node.map((child, i) => <Fragment key={i}>{highlightDeep(child, term)}</Fragment>);
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const element = node;
    return cloneElement(element, { children: highlightDeep(element.props.children, term) });
  }
  return node;
}

const FILTERS: { key: Filter; labelKey: string }[] = [
  { key: "active", labelKey: "InProgress" },
  { key: "all", labelKey: "All" },
  { key: "done", labelKey: "Done" },
];

export function TodoPanel() {
  const { t } = useI18n();
  const { todos, loading, addTodo, updateTodo, deleteTodo, toggleDone } = useTodos();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<Filter>("all");
  const [draftMode, setDraftMode] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const visible = useMemo(() => {
    let list = filter === "all"
      ? todos
      : filter === "active"
        ? todos.filter((x) => !x.done)
        : todos.filter((x) => x.done);
    const term = searchTerm.trim().toLowerCase();
    if (term) {
      list = list.filter((x) =>
        x.title.toLowerCase().includes(term) ||
        (x.description ?? "").toLowerCase().includes(term)
      );
    }
    const sortKey: keyof Todo = filter === "done" ? "completedAt" : "createdAt";
    return [...list].sort((a, b) => {
      const av = (a[sortKey] as number | undefined) ?? 0;
      const bv = (b[sortKey] as number | undefined) ?? 0;
      return bv - av;
    });
  }, [todos, filter, searchTerm]);

  const handleAddClick = () => {
    if (draftMode) return;
    setFilter("all");
    setDraftMode(true);
  };

  const handleDraftSubmit = async (value: { title: string; deadline?: number }) => {
    const trimmed = value.title.trim();
    if (trimmed.length === 0) {
      setDraftMode(false);
      return;
    }
    const todo = await addTodo(trimmed, { deadline: value.deadline });
    setDraftMode(false);
    if (todo) setFilter("active");
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)" }}>
      <FilterBar
        current={filter}
        onChange={setFilter}
        onAdd={handleAddClick}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
      />
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px" }}>
        {loading && todos.length === 0 && (
          <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
            {t("Loading...")}
          </div>
        )}
        {!loading && visible.length === 0 && !draftMode && (
          <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
            {searchTerm.trim() ? t("No matches") : t("No todos")}
          </div>
        )}
        {draftMode && (
          <DraftRow onSubmit={handleDraftSubmit} onCancel={() => setDraftMode(false)} />
        )}
        {visible.map((todo) => (
          <TodoItem
            key={todo.id}
            todo={todo}
            onToggleDone={() => toggleDone(todo.id)}
            onUpdate={(patch) => updateTodo(todo.id, patch)}
            onDelete={() => handleDelete(todo)}
            searchTerm={searchTerm}
          />
        ))}
      </div>
    </div>
  );
}

function FilterBar({
  current,
  onChange,
  onAdd,
  searchTerm,
  onSearchChange,
}: {
  current: Filter;
  onChange: (f: Filter) => void;
  onAdd: () => void;
  searchTerm: string;
  onSearchChange: (v: string) => void;
}) {
  const { t } = useI18n();
  const searchRef = useRef<HTMLInputElement | null>(null);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
      {FILTERS.map((f) => {
        const active = current === f.key;
        return (
          <button
            key={f.key}
            onClick={() => onChange(f.key)}
            style={{
              padding: "3px 10px",
              fontSize: 11,
              flexShrink: 0,
              background: active ? "var(--bg-selected)" : "transparent",
              border: "1px solid var(--border)",
              borderRadius: 10,
              cursor: "pointer",
              color: active ? "var(--text)" : "var(--text-muted)",
              transition: "background 0.1s, color 0.1s",
            }}
          >
            {t(f.labelKey)}
          </button>
        );
      })}
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
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
          <circle cx="4.5" cy="4.5" r="2.5" />
          <line x1="6.5" y1="6.5" x2="9" y2="9" />
        </svg>
        <input
          ref={searchRef}
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("Search todos…")}
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
        {searchTerm.length > 0 && (
          <button
            onClick={() => {
              onSearchChange("");
              searchRef.current?.focus();
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
      <button
        onClick={onAdd}
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "3px 10px",
          fontSize: 11,
          flexShrink: 0,
          background: "var(--accent)",
          border: "none",
          borderRadius: 10,
          color: "var(--bg)",
          cursor: "pointer",
          fontWeight: 500,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="5" y1="1" x2="5" y2="9" />
          <line x1="1" y1="5" x2="9" y2="5" />
        </svg>
        {t("Add")}
      </button>
    </div>
  );
}

function DraftRow({ onSubmit, onCancel }: { onSubmit: (value: { title: string; deadline?: number }) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState<number | undefined>(undefined);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const submit = () => {
    onSubmit({ title, deadline });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 6px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 14, height: 14, flexShrink: 0, border: "1.5px solid var(--text-dim)", borderRadius: 3 }} />
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("New")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => {
            if (title.trim().length === 0) onCancel();
            else submit();
          }}
          style={{
            flex: 1, minWidth: 0,
            padding: "2px 4px",
            fontSize: 13,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--text)",
            fontFamily: "inherit",
          }}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 22 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
          <CalendarIcon />
          {t("Deadline")}
        </span>
        <input
          type="date"
          value={deadline !== undefined ? formatDateForInput(deadline) : ""}
          onChange={(e) => setDeadline(endOfDayFromInput(e.target.value))}
          aria-label={t("Pick a date")}
          style={{
            flex: 1, minWidth: 0,
            padding: "1px 4px",
            fontSize: 11,
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 3,
            outline: "none",
            color: "var(--text-muted)",
            fontFamily: "inherit",
            colorScheme: "dark",
          }}
        />
      </div>
    </div>
  );
}

function TodoItem({
  todo,
  onToggleDone,
  onUpdate,
  onDelete,
  searchTerm,
}: {
  todo: Todo;
  onToggleDone: () => void;
  onUpdate: (patch: { title?: string; description?: string; done?: boolean; deadline?: number }) => void;
  onDelete: () => void;
  searchTerm: string;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const cm = useContextMenu();
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [titleDraft, setTitleDraft] = useState(todo.title);
  const deadlineInputRef = useRef<HTMLInputElement | null>(null);

  const openDeadlinePicker = () => {
    const el = deadlineInputRef.current;
    if (!el) return;
    if (typeof el.showPicker === "function") el.showPicker();
    else el.focus();
  };

  const markdownComponents = useMemo(() => {
    if (!searchTerm) return undefined;
    const wrap = (children: ReactNode) => highlightDeep(children, searchTerm);
    const passthrough = (Tag: string) => {
      const Component = (props: { children?: ReactNode }) => {
        const { children, ...rest } = props;
        return createElement(Tag, rest, wrap(children));
      };
      Component.displayName = `Highlight(${Tag})`;
      return Component;
    };
    return {
      p: passthrough("p"),
      li: passthrough("li"),
      h1: passthrough("h1"),
      h2: passthrough("h2"),
      h3: passthrough("h3"),
      h4: passthrough("h4"),
      h5: passthrough("h5"),
      h6: passthrough("h6"),
      td: passthrough("td"),
      th: passthrough("th"),
      em: passthrough("em"),
      strong: passthrough("strong"),
      a: passthrough("a"),
      code: passthrough("code"),
    };
  }, [searchTerm]);

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

  const hasLongDescription = (todo.description ?? "").split("\n").length > 5;

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
            onDoubleClick={() => { setTitleDraft(todo.title); setEditingTitle(true); }}
            style={{
              flex: 1, minWidth: 0,
              fontSize: 13, fontWeight: 500,
              color: todo.done ? "var(--text-muted)" : "var(--accent)",
              textDecoration: todo.done ? "line-through" : "none",
              cursor: "text",
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
          inputRef={deadlineInputRef}
          onChange={(v) => onUpdate({ deadline: v })}
        />
      </div>
      {editingDesc ? (
        <MarkdownEditor
          defaultValue={todo.description ?? ""}
          onSave={commitDescription}
          onCancel={() => setEditingDesc(false)}
          placeholder={t("Add description...")}
        />
      ) : (
        <div style={{ marginLeft: 22 }}>
          <div
            onDoubleClick={() => setEditingDesc(true)}
            style={{
              minHeight: 18,
              fontSize: 12,
              lineHeight: 1.5,
              color: todo.done ? "var(--text-dim)" : "var(--text-muted)",
              textDecoration: todo.done ? "line-through" : "none",
              textDecorationColor: todo.done ? "var(--text-muted)" : undefined,
              cursor: "text",
              padding: "2px 0",
            }}
          >
            {todo.description ? (
              <div
                className="markdown-body"
                style={{
                  fontSize: 12,
                  ...(hasLongDescription && !expanded
                    ? {
                        display: "-webkit-box",
                        WebkitLineClamp: 5,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }
                    : {}),
                }}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{todo.description}</ReactMarkdown>
              </div>
            ) : (
              <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>{t("Add description...")}</span>
            )}
          </div>
          {hasLongDescription && (
            <button
              onClick={() => setExpanded((v) => !v)}
              style={{
                marginTop: 2,
                padding: 0,
                background: "none",
                border: "none",
                color: "var(--accent)",
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {expanded ? t("Collapse") : t("Expand")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DeadlineControl({
  todo,
  inputRef,
  onChange,
}: {
  todo: Todo;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (v: number | undefined) => void;
}) {
  const { t } = useI18n();

  // Always render a hidden-but-layout-present <input type="date">. The visible
  // button calls showPicker() on it so the user gets the native calendar in one
  // click, with no intermediate "edit box" state.
  const hiddenInput = (
    <input
      ref={inputRef}
      type="date"
      value={todo.deadline !== undefined ? formatDateForInput(todo.deadline) : ""}
      onChange={(e) => {
        const v = endOfDayFromInput(e.target.value);
        if (v !== undefined) onChange(v);
      }}
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        padding: 0,
        margin: 0,
        border: 0,
        opacity: 0,
        pointerEvents: "none",
      }}
      tabIndex={-1}
      aria-hidden
    />
  );

  const handleClick = () => {
    const el = inputRef.current;
    if (!el) return;
    if (typeof el.showPicker === "function") el.showPicker();
    else el.focus();
  };

  if (todo.deadline === undefined) {
    return (
      <span style={{ position: "relative", display: "inline-flex" }}>
        {hiddenInput}
        <button
          onClick={handleClick}
          aria-label={t("Set deadline")}
          title={t("Set deadline")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 20, height: 20, padding: 0,
            flexShrink: 0,
            background: "transparent",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            borderRadius: 3,
            fontFamily: "inherit",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
        >
          <CalendarIcon />
        </button>
      </span>
    );
  }

  const { label, tone } = formatDeadline(todo.deadline);
  const color = todo.done
    ? "var(--text-dim)"
    : tone === "overdue" ? "#ef4444" : tone === "today" ? "var(--accent)" : "var(--text-muted)";
  const suffix = todo.done || tone === "future"
    ? ""
    : tone === "overdue" ? ` (${t("Overdue")})` : ` (${t("Due today")})`;
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      {hiddenInput}
      <button
        onClick={handleClick}
        aria-label={t("Change deadline")}
        title={t("Change deadline")}
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "1px 6px", fontSize: 11,
          flexShrink: 0,
          background: "transparent",
          border: "none",
          color,
          cursor: "pointer",
          borderRadius: 3,
          fontFamily: "inherit",
          textDecoration: todo.done ? "line-through" : "none",
        }}
        onMouseEnter={(e) => { if (!todo.done) e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = color; }}
      >
        <CalendarIcon /> {label}{suffix}
      </button>
    </span>
  );
}
