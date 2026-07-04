"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useToast } from "@/components/Toast";
import { useI18n } from "./useI18n";

export interface Tag {
  name: string;
  color?: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  tags: Tag[];
}

export type NotePatch = Partial<Pick<Note, "title" | "content" | "tags">>;

interface NoteContextValue {
  notes: Note[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addNote: (title?: string, opts?: { content?: string; tags?: Tag[] }) => Promise<Note | null>;
  updateNote: (id: string, patch: NotePatch) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  renameTag: (from: string, to: string) => Promise<{ tag: string; affected: number } | null>;
  deleteTag: (tag: string) => Promise<{ tag: string; affected: number } | null>;
  setTagColor: (tag: string, color: string | null) => Promise<{ tag: string; color: string | null; affected: number } | null>;
}

const NoteContext = createContext<NoteContextValue | null>(null);

export function NotesProvider({ children }: { children: ReactNode }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const { t } = useI18n();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notes");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { notes?: Note[] };
      setNotes(data.notes ?? []);
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

  const addNote = useCallback(async (title?: string, opts?: { content?: string; tags?: Tag[] }): Promise<Note | null> => {
    const trimmed = (title ?? "").trim();
    const finalTitle = trimmed.length > 0 ? trimmed : "Untitled";
    const content = opts?.content ?? "";
    const tags = opts?.tags ?? [];
    // Optimistic placeholder
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic: Note = {
      id: tempId,
      title: finalTitle,
      content,
      createdAt: Date.now(),
      tags,
    };
    setNotes((prev) => [optimistic, ...prev]);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: finalTitle, content, tags }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(error || `status ${res.status}`);
      }
      const { note } = (await res.json()) as { note: Note };
      setNotes((prev) => prev.map((x) => (x.id === tempId ? note : x)));
      return note;
    } catch (e) {
      setNotes((prev) => prev.filter((x) => x.id !== tempId));
      toast.show({ kind: "error", message: t("Failed to create note") + ": " + String(e) });
      return null;
    }
  }, [toast, t]);

  const updateNote = useCallback(async (id: string, patch: NotePatch) => {
    let snapshot: Note | undefined;
    setNotes((prev) => prev.map((x) => {
      if (x.id !== id) return x;
      snapshot = x;
      return { ...x, ...patch };
    }));
    if (!snapshot) return;
    try {
      const res = await fetch("/api/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(error || `status ${res.status}`);
      }
      const { note } = (await res.json()) as { note: Note };
      setNotes((prev) => prev.map((x) => (x.id === id ? note : x)));
    } catch (e) {
      setNotes((prev) => prev.map((x) => (x.id === id ? snapshot! : x)));
      toast.show({ kind: "error", message: t("Failed to save note") + ": " + String(e) });
    }
  }, [toast, t]);

  const deleteNote = useCallback(async (id: string) => {
    let snapshot: Note | undefined;
    setNotes((prev) => {
      const found = prev.find((x) => x.id === id);
      snapshot = found;
      return prev.filter((x) => x.id !== id);
    });
    if (!snapshot) return;
    try {
      const res = await fetch(`/api/notes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(error || `status ${res.status}`);
      }
      toast.show({ kind: "success", message: t("Deleted") });
    } catch (e) {
      setNotes((prev) => (snapshot ? [snapshot, ...prev] : prev));
      toast.show({ kind: "error", message: t("Failed to delete note") + ": " + String(e) });
    }
  }, [toast, t]);

  // Tag-level operations. Both go through the server and then refresh the
  // local list — no optimistic snapshots, the DB is the source of truth and
  // the affected notes' tag arrays are easier to re-derive than to splice
  // by hand.
  const renameTag = useCallback(async (from: string, to: string) => {
    try {
      const res = await fetch("/api/notes-tags", {
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
      const res = await fetch("/api/notes-tags", {
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
      const res = await fetch("/api/notes-tags/color", {
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

  const value = useMemo<NoteContextValue>(() => ({
    notes, loading, error, refresh, addNote, updateNote, deleteNote, renameTag, deleteTag, setTagColor,
  }), [notes, loading, error, refresh, addNote, updateNote, deleteNote, renameTag, deleteTag, setTagColor]);

  return <NoteContext.Provider value={value}>{children}</NoteContext.Provider>;
}

export function useNotes(): NoteContextValue {
  const ctx = useContext(NoteContext);
  if (!ctx) throw new Error("useNotes must be used within NotesProvider");
  return ctx;
}