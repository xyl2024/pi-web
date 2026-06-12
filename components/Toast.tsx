"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type ToastKind = "success" | "error" | "info";

interface ToastInput {
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
const EXIT_ANIMATION_MS = 220;
const MAX_VISIBLE = 4;
const DEDUPE_WINDOW_MS = 1000;

let _idCounter = 0;
function nextId(): string {
  _idCounter += 1;
  return `toast-${Date.now()}-${_idCounter}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastShownRef = useRef<Map<string, number>>(new Map());

  const removeItem = useCallback((id: string) => {
    setItems((prev) => (prev.some((it) => it.id === id) ? prev.filter((it) => it.id !== id) : prev));
    setExitingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  const dismiss = useCallback((id: string) => {
    setExitingIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setTimeout(() => removeItem(id), EXIT_ANIMATION_MS);
  }, [removeItem]);

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
      <ToastViewport items={items} exitingIds={exitingIds} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

function ToastViewport({
  items,
  exitingIds,
  onDismiss,
}: {
  items: ToastItem[];
  exitingIds: Set<string>;
  onDismiss: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column-reverse",
        alignItems: "center",
        gap: 8,
        pointerEvents: "none",
        maxWidth: "calc(100vw - 32px)",
      }}
    >
      {items.map((it) => (
        <ToastCard
          key={it.id}
          item={it}
          exiting={exitingIds.has(it.id)}
          onDismiss={() => onDismiss(it.id)}
        />
      ))}
    </div>
  );
}

const KIND_ACCENT: Record<ToastKind, string> = {
  success: "var(--accent)",
  error: "#f87171",
  info: "var(--text-muted)",
};

function ToastCard({
  item,
  exiting,
  onDismiss,
}: {
  item: ToastItem;
  exiting: boolean;
  onDismiss: () => void;
}) {
  return (
    <div
      onClick={onDismiss}
      className={exiting ? "pi-toast-exit" : "pi-toast-enter"}
      style={{
        pointerEvents: "auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${KIND_ACCENT[item.kind]}`,
        borderRadius: 8,
        padding: "8px 16px 8px 12px",
        fontSize: 13,
        lineHeight: 1.4,
        color: "var(--text)",
        cursor: "pointer",
        boxShadow: "0 4px 16px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.08)",
        maxWidth: "100%",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        willChange: "transform, opacity",
      }}
    >
      <ToastIcon kind={item.kind} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.message}</span>
    </div>
  );
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  const color = KIND_ACCENT[kind];
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    style: { flexShrink: 0 },
  };
  if (kind === "success") {
    return (
      <svg {...common}>
        <path d="M3 8.5l3.5 3.5 6.5-7" />
      </svg>
    );
  }
  if (kind === "error") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7v4" />
      <circle cx="8" cy="4.75" r="0.6" fill={color} stroke="none" />
    </svg>
  );
}
