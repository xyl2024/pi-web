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
}

export type TodoPatch = Partial<Pick<Todo, "title" | "description" | "done">>;

interface TodoContextValue {
  todos: Todo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addTodo: (title: string, description?: string) => Promise<Todo | null>;
  updateTodo: (id: string, patch: TodoPatch) => Promise<void>;
  deleteTodo: (id: string) => Promise<void>;
  toggleDone: (id: string) => Promise<void>;
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

  const addTodo = useCallback(async (title: string, description?: string): Promise<Todo | null> => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return null;
    // Optimistic placeholder
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic: Todo = {
      id: tempId,
      title: trimmed,
      description,
      done: false,
      createdAt: Date.now(),
    };
    setTodos((prev) => [optimistic, ...prev]);
    try {
      const res = await fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed, description }),
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
      const res = await fetch("/api/todos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
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

  const value = useMemo<TodoContextValue>(() => ({
    todos, loading, error, refresh, addTodo, updateTodo, deleteTodo, toggleDone,
  }), [todos, loading, error, refresh, addTodo, updateTodo, deleteTodo, toggleDone]);

  return <TodoContext.Provider value={value}>{children}</TodoContext.Provider>;
}

export function useTodos(): TodoContextValue {
  const ctx = useContext(TodoContext);
  if (!ctx) throw new Error("useTodos must be used within TodoProvider");
  return ctx;
}
