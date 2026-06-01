"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastKind = "success" | "error" | "info";

export interface ToastInput {
  kind?: ToastKind;
  message: string;
  durationMs?: number;
}

interface ToastItem extends Required<Pick<ToastInput, "kind" | "durationMs">> {
  id: string;
  message: string;
}

interface ToastContextValue {
  show: (input: ToastInput) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 2500;
const MAX_VISIBLE = 4;
const DEDUPE_WINDOW_MS = 1000;

let _idCounter = 0;
function nextId(): string {
  _idCounter += 1;
  return `toast-${Date.now()}-${_idCounter}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastShownRef = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const show = useCallback((input: ToastInput) => {
    const kind = input.kind ?? "info";
    const message = input.message;
    const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;

    // Dedupe: same kind+message within DEDUPE_WINDOW_MS is ignored
    const key = `${kind}:${message}`;
    const now = Date.now();
    const last = lastShownRef.current.get(key) ?? 0;
    if (now - last < DEDUPE_WINDOW_MS) return;
    lastShownRef.current.set(key, now);

    const id = nextId();
    const item: ToastItem = { id, kind, message, durationMs };

    setItems((prev) => {
      const next = [...prev, item];
      // Cap visible
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });

    const timer = setTimeout(() => dismiss(id), durationMs);
    timersRef.current.set(id, timer);
  }, [dismiss]);

  const value = useMemo<ToastContextValue>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

function ToastViewport({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        pointerEvents: "none",
        maxWidth: 360,
      }}
    >
      {items.map((it) => (
        <ToastCard key={it.id} item={it} onDismiss={() => onDismiss(it.id)} />
      ))}
    </div>
  );
}

const KIND_BORDER: Record<ToastKind, string> = {
  success: "var(--accent)",
  error: "#f87171",
  info: "var(--text-muted)",
};

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  return (
    <div
      onClick={onDismiss}
      style={{
        pointerEvents: "auto",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${KIND_BORDER[item.kind]}`,
        borderRadius: 4,
        padding: "8px 12px",
        fontSize: 12,
        color: "var(--text)",
        cursor: "pointer",
        boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
        animation: "pi-toast-in 160ms ease-out",
      }}
    >
      {item.message}
      <style>{`@keyframes pi-toast-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}
