"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";
import { useToast } from "@/components/Toast";
import { useI18n } from "./useI18n";
import { buildDescriptionSanitizeConfig } from "@/lib/description-sanitize";

export interface Tag {
  name: string;
  color?: string;
}

export interface Todo {
  id: string;
  title: string;
  description?: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
  deadline?: number;
  tags: Tag[];
}

export type TodoPatch = Partial<Pick<Todo, "title" | "description" | "done" | "deadline" | "tags">>;

interface TodoContextValue {
  todos: Todo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addTodo: (title: string, opts?: { description?: string; deadline?: number; tags?: Tag[] }) => Promise<Todo | null>;
  updateTodo: (id: string, patch: TodoPatch) => Promise<void>;
  deleteTodo: (id: string) => Promise<void>;
  toggleDone: (id: string) => Promise<void>;
  exportTodo: (id: string) => Promise<void>;
  renameTag: (from: string, to: string) => Promise<{ tag: string; affected: number } | null>;
  deleteTag: (tag: string) => Promise<{ tag: string; affected: number } | null>;
  setTagColor: (tag: string, color: string | null) => Promise<{ tag: string; color: string | null; affected: number } | null>;
}

const TodoContext = createContext<TodoContextValue | null>(null);

// Mirrors lib/todo-store.ts — kept narrow on purpose so legacy Markdown that
// slips through the heuristic doesn't smuggle a <script> tag into the DB.
// `allowStyle: false` because legacy markdown has no color spans; nothing
// to gain from opening `style` for this code path.
const MIGRATION_SANITIZE_CONFIG = buildDescriptionSanitizeConfig({ allowStyle: false });

/**
 * Heuristic: does this string look like legacy Markdown rather than Tiptap
 * HTML? Used to gate the lazy markdown→HTML migration in `refresh()`. Skips
 * anything that already starts with a tag, anything that contains a
 * Tiptap-specific marker (data-type="taskList" or language-mermaid), and
 * anything that's pure plain text. Heuristics:
 *   - at least one markdown line marker (heading / list / quote / image / fence)
 *   - OR bold / italic with paired markers (** / __)
 */
function looksLikeMarkdown(s: string): boolean {
  if (!s) return false;
  const t = s.trimStart();
  if (t.startsWith("<")) return false;
  // Tiptap outputs — already converted, skip.
  if (/data-type="taskList"|data-type="taskItem"|class="language-mermaid"/.test(s)) return false;
  // Image / link markdown that's not yet inside <a>/<img> tags
  if (/!\[[^\]]*\]\([^)]+\)/.test(s)) return true;
  if (/\[[^\]]+\]\([^)]+\)/.test(s)) return true;
  if (/(^|\n)#{1,6}\s+\S/.test(s)) return true;
  if (/(^|\n)\s*[-*+]\s+\S/.test(s)) return true;
  if (/(^|\n)\s*\d+\.\s+\S/.test(s)) return true;
  if (/(^|\n)>\s/.test(s)) return true;
  if (/```/.test(s)) return true;
  if (/\*\*[^*\n]+\*\*/.test(s) || /(^|\W)__[^_\n]+__(?=\W|$)/.test(s)) return true;
  return false;
}

export function TodoProvider({ children }: { children: ReactNode }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const { t } = useI18n();
  // Track ids we've already attempted to migrate this session so refresh()
  // doesn't repeatedly hit the API for the same todo. Re-mounting (page
  // reload) naturally re-attempts; that's fine — successful migration means
  // the server no longer returns markdown, so the second pass is a no-op.
  const migratedRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/todos");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { todos?: Todo[] };
      const list = data.todos ?? [];
      setTodos(list);
      setError(null);
      // Best-effort migration. Failures are isolated and toast-reported.
      void migrateMarkdownTodos(list, migratedRef.current, setTodos, toast, t);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [toast, t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addTodo = useCallback(async (title: string, opts?: { description?: string; deadline?: number; tags?: Tag[] }): Promise<Todo | null> => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return null;
    const description = opts?.description;
    // Default new todos to today (end-of-day) — matches the convention the
    // deadline picker uses so the "Due today" tone lights up immediately.
    const deadline = opts?.deadline ?? new Date(new Date().setHours(23, 59, 59, 999)).getTime();
    const tags = opts?.tags ?? [];
    // Optimistic placeholder
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic: Todo = {
      id: tempId,
      title: trimmed,
      description,
      done: false,
      createdAt: Date.now(),
      deadline,
      tags,
    };
    setTodos((prev) => [optimistic, ...prev]);
    try {
      const res = await fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed, description, deadline, tags }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(error || `status ${res.status}`);
      }
      const { todo } = (await res.json()) as { todo: Todo };
      setTodos((prev) => prev.map((x) => (x.id === tempId ? todo : x)));
      return todo;
    } catch (e) {
      setTodos((prev) => prev.filter((x) => x.id !== tempId));
      toast.show({ kind: "error", message: t("Save failed") + ": " + String(e) });
      return null;
    }
  }, [toast, t]);

  const updateTodo = useCallback(async (id: string, patch: TodoPatch) => {
    let snapshot: Todo | undefined;
    setTodos((prev) => prev.map((x) => {
      if (x.id !== id) return x;
      snapshot = x;
      // Optimistic update; server is the source of truth for completedAt
      const optimisticCompletedAt = patch.done === undefined
        ? x.completedAt
        : (patch.done ? Date.now() : undefined);
      return { ...x, ...patch, completedAt: optimisticCompletedAt };
    }));
    if (!snapshot) return;
    try {
      // JSON.stringify drops `undefined` fields, so an explicit clear of deadline
      // would look identical to "no change" to the server. Send `null` instead.
      const body: Record<string, unknown> = { id, ...patch };
      if ("deadline" in patch && patch.deadline === undefined) {
        body.deadline = null;
      }
      const res = await fetch("/api/todos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(error || `status ${res.status}`);
      }
      const { todo } = (await res.json()) as { todo: Todo };
      setTodos((prev) => prev.map((x) => (x.id === id ? todo : x)));
    } catch (e) {
      setTodos((prev) => prev.map((x) => (x.id === id ? snapshot! : x)));
      toast.show({ kind: "error", message: t("Save failed") + ": " + String(e) });
    }
  }, [toast, t]);

  const deleteTodo = useCallback(async (id: string) => {
    let snapshot: Todo | undefined;
    setTodos((prev) => {
      const found = prev.find((x) => x.id === id);
      snapshot = found;
      return prev.filter((x) => x.id !== id);
    });
    if (!snapshot) return;
    try {
      const res = await fetch(`/api/todos?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(error || `status ${res.status}`);
      }
    } catch (e) {
      setTodos((prev) => (snapshot ? [snapshot, ...prev] : prev));
      toast.show({ kind: "error", message: t("Delete failed") + ": " + String(e) });
    }
  }, [toast, t]);

  const toggleDone = useCallback(async (id: string) => {
    let snapshot: Todo | undefined;
    setTodos((prev) => prev.map((x) => {
      if (x.id !== id) return x;
      snapshot = x;
      const nextDone = !x.done;
      return { ...x, done: nextDone, completedAt: nextDone ? Date.now() : undefined };
    }));
    if (!snapshot) return;
    try {
      const res = await fetch("/api/todos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, done: !snapshot.done }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(error || `status ${res.status}`);
      }
      const { todo } = (await res.json()) as { todo: Todo };
      setTodos((prev) => prev.map((x) => (x.id === id ? todo : x)));
    } catch (e) {
      setTodos((prev) => prev.map((x) => (x.id === id ? snapshot! : x)));
      toast.show({ kind: "error", message: t("Save failed") + ": " + String(e) });
    }
  }, [toast, t]);

  // Download a zip of one todo (markdown + referenced images). Parses both
  // RFC 5987 `filename*=UTF-8''...` and legacy `filename="..."` forms of
  // Content-Disposition so CJK titles round-trip correctly.
  const exportTodo = useCallback(async (id: string) => {
    const res = await fetch(`/api/todos/${encodeURIComponent(id)}/export`);
    if (!res.ok) {
      const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
      throw new Error(error || `status ${res.status}`);
    }
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") ?? "";
    let filename = `todo-${id}.zip`;
    const mStar = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (mStar) {
      try { filename = decodeURIComponent(mStar[1]); } catch { /* keep fallback */ }
    } else {
      const mPlain = /filename="?([^";]+)"?/i.exec(cd);
      if (mPlain) filename = mPlain[1];
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  // Tag-level operations. Both go through the server and then refresh the
  // local list — no optimistic snapshots, the DB is the source of truth and
  // the affected todos' tag arrays are easier to re-derive than to splice
  // by hand.
  const renameTag = useCallback(async (from: string, to: string) => {
    try {
      const res = await fetch("/api/tags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(error || `status ${res.status}`);
      }
      const data = (await res.json()) as { tag: string; affected: number };
      await refresh();
      return data;
    } catch (e) {
      toast.show({ kind: "error", message: t("Failed to rename tag") + ": " + String(e) });
      return null;
    }
  }, [toast, t, refresh]);

  const deleteTag = useCallback(async (tag: string) => {
    try {
      const res = await fetch("/api/tags", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(error || `status ${res.status}`);
      }
      const data = (await res.json()) as { tag: string; affected: number };
      await refresh();
      return data;
    } catch (e) {
      toast.show({ kind: "error", message: t("Failed to delete tag") + ": " + String(e) });
      return null;
    }
  }, [toast, t, refresh]);

  const setTagColor = useCallback(async (tag: string, color: string | null) => {
    try {
      const res = await fetch("/api/tags/color", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag, color }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(error || `status ${res.status}`);
      }
      const data = (await res.json()) as { tag: string; color: string | null; affected: number };
      toast.show({ kind: "success", message: t("Tag color updated") });
      await refresh();
      return data;
    } catch (e) {
      toast.show({ kind: "error", message: t("Failed to set tag color") + ": " + String(e) });
      return null;
    }
  }, [toast, t, refresh]);

  const value = useMemo<TodoContextValue>(() => ({
    todos, loading, error, refresh, addTodo, updateTodo, deleteTodo, toggleDone, exportTodo, renameTag, deleteTag, setTagColor,
  }), [todos, loading, error, refresh, addTodo, updateTodo, deleteTodo, toggleDone, exportTodo, renameTag, deleteTag, setTagColor]);

  return <TodoContext.Provider value={value}>{children}</TodoContext.Provider>;
}

export function useTodos(): TodoContextValue {
  const ctx = useContext(TodoContext);
  if (!ctx) throw new Error("useTodos must be used within TodoProvider");
  return ctx;
}

// ---------------------------------------------------------------------------
// Lazy markdown → HTML migration
// ---------------------------------------------------------------------------

async function migrateMarkdownTodos(
  list: Todo[],
  done: Set<string>,
  setTodos: React.Dispatch<React.SetStateAction<Todo[]>>,
  toast: { show: (input: { kind: "info" | "error" | "success"; message: string }) => void },
  t: (key: string) => string,
): Promise<void> {
  const targets = list.filter((x) => x.description && !done.has(x.id) && looksLikeMarkdown(x.description));
  if (targets.length === 0) return;
  let successCount = 0;
  let lastError: string | null = null;
  for (const todo of targets) {
    done.add(todo.id);
    try {
      const raw = marked.parse(todo.description as string, { async: false }) as string;
      const html = DOMPurify.sanitize(raw, MIGRATION_SANITIZE_CONFIG);
      if (!html || html === todo.description) continue;
      const res = await fetch("/api/todos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: todo.id, description: html }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `status ${res.status}`);
      }
      const { todo: updated } = (await res.json()) as { todo: Todo };
      setTodos((prev) => prev.map((x) => (x.id === todo.id ? updated : x)));
      successCount++;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  if (successCount > 0) {
    toast.show({
      kind: "info",
      message: t("Migrated {n} todo description to rich text")
        .replace("{n}", String(successCount)),
    });
  }
  if (lastError) {
    toast.show({
      kind: "error",
      message: t("Save failed") + ": " + lastError,
    });
  }
}
