"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useToast } from "@/components/Toast";
import { useI18n } from "./useI18n";

export interface Todo {
  id: string;
  title: string;
  description?: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
  deadline?: number;
  tags: string[];
}

export type TodoPatch = Partial<Pick<Todo, "title" | "description" | "done" | "deadline" | "tags">>;

interface TodoContextValue {
  todos: Todo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addTodo: (title: string, opts?: { description?: string; deadline?: number; tags?: string[] }) => Promise<Todo | null>;
  updateTodo: (id: string, patch: TodoPatch) => Promise<void>;
  deleteTodo: (id: string) => Promise<void>;
  toggleDone: (id: string) => Promise<void>;
  exportTodo: (id: string) => Promise<void>;
}

const TodoContext = createContext<TodoContextValue | null>(null);

export function TodoProvider({ children }: { children: ReactNode }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const { t } = useI18n();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/todos");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { todos?: Todo[] };
      setTodos(data.todos ?? []);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addTodo = useCallback(async (title: string, opts?: { description?: string; deadline?: number; tags?: string[] }): Promise<Todo | null> => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return null;
    const description = opts?.description;
    const deadline = opts?.deadline;
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

  const value = useMemo<TodoContextValue>(() => ({
    todos, loading, error, refresh, addTodo, updateTodo, deleteTodo, toggleDone, exportTodo,
  }), [todos, loading, error, refresh, addTodo, updateTodo, deleteTodo, toggleDone, exportTodo]);

  return <TodoContext.Provider value={value}>{children}</TodoContext.Provider>;
}

export function useTodos(): TodoContextValue {
  const ctx = useContext(TodoContext);
  if (!ctx) throw new Error("useTodos must be used within TodoProvider");
  return ctx;
}
