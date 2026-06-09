"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "@/hooks/useI18n";
import { useTodos, type Todo } from "@/hooks/useTodos";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useContextMenu, type ContextMenuItem } from "@/components/ContextMenu";

type Filter = "active" | "all" | "done";

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

  const visible = useMemo(() => {
    const list = filter === "all"
      ? todos
      : filter === "active"
        ? todos.filter((x) => !x.done)
        : todos.filter((x) => x.done);
    const sortKey: keyof Todo = filter === "done" ? "completedAt" : "createdAt";
    return [...list].sort((a, b) => {
      const av = (a[sortKey] as number | undefined) ?? 0;
      const bv = (b[sortKey] as number | undefined) ?? 0;
      return bv - av;
    });
  }, [todos, filter]);

  const handleAddClick = () => {
    if (draftMode) return;
    setFilter("all");
    setDraftMode(true);
  };

  const handleDraftSubmit = async (title: string) => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setDraftMode(false);
      return;
    }
    const todo = await addTodo(trimmed);
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
      <FilterBar current={filter} onChange={setFilter} onAdd={handleAddClick} />
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px" }}>
        {loading && todos.length === 0 && (
          <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
            {t("Loading...")}
          </div>
        )}
        {!loading && visible.length === 0 && !draftMode && (
          <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
            {t("No todos")}
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
          />
        ))}
      </div>
    </div>
  );
}

function FilterBar({ current, onChange, onAdd }: { current: Filter; onChange: (f: Filter) => void; onAdd: () => void }) {
  const { t } = useI18n();
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
      <span style={{ flex: 1 }} />
      <button
        onClick={onAdd}
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "3px 10px",
          fontSize: 11,
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

function DraftRow({ onSubmit, onCancel }: { onSubmit: (title: string) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 6px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ width: 14, height: 14, flexShrink: 0, border: "1.5px solid var(--text-dim)", borderRadius: 3 }} />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("New")}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (value.trim().length === 0) onCancel();
          else onSubmit(value);
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
  );
}

function TodoItem({
  todo,
  onToggleDone,
  onUpdate,
  onDelete,
}: {
  todo: Todo;
  onToggleDone: () => void;
  onUpdate: (patch: { title?: string; description?: string; done?: boolean }) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const cm = useContextMenu();
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [titleDraft, setTitleDraft] = useState(todo.title);

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

  const descRows = Math.min(8, Math.max(2, (todo.description ?? "").split("\n").length));
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
            {todo.title}
          </span>
        )}
      </div>
      {editingDesc ? (
        <textarea
          autoFocus
          defaultValue={todo.description ?? ""}
          rows={descRows}
          onBlur={(e) => commitDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
          }}
          placeholder={t("Add description...")}
          style={{
            width: "100%",
            padding: "4px 6px",
            fontSize: 12,
            background: "var(--bg-selected)",
            border: "1px solid var(--accent)",
            borderRadius: 3,
            outline: "none",
            resize: "vertical",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            lineHeight: 1.5,
            marginLeft: 22,
          }}
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
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{todo.description}</ReactMarkdown>
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
