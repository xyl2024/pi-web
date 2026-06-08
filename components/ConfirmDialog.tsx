"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Hold the latest pending in a ref so async resolves always see the right one.
  const pendingRef = useRef<PendingConfirm | null>(null);
  pendingRef.current = pending;

  const resolve = useCallback((ok: boolean) => {
    const cur = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    cur?.resolve(ok);
  }, []);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    // If a dialog is already open, resolve the previous one as false first.
    if (pendingRef.current) {
      pendingRef.current.resolve(false);
    }
    return new Promise<boolean>((resolveFn) => {
      setPending({ ...options, resolve: resolveFn });
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolve(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        resolve(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, resolve]);

  const value = useMemo<ConfirmContextValue>(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && <ConfirmDialogView options={pending} onResolve={resolve} />}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx.confirm;
}

function ConfirmDialogView({
  options,
  onResolve,
}: {
  options: ConfirmOptions;
  onResolve: (ok: boolean) => void;
}) {
  const { t } = useI18n();
  const destructive = options.destructive ?? true;
  const confirmLabel = options.confirmLabel ?? t("Delete");
  const cancelLabel = options.cancelLabel ?? t("Cancel");

  // Portal target. Mount after first client render to avoid SSR mismatch.
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalEl(document.body);
  }, []);

  if (!portalEl) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // Click on backdrop (outside the card) cancels
        if (e.target === e.currentTarget) onResolve(false);
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 20,
          minWidth: 320,
          maxWidth: 480,
          boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{options.title}</div>
        {options.description && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", wordBreak: "break-all" }}>
            {options.description}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            onClick={() => onResolve(false)}
            style={{
              padding: "6px 14px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {cancelLabel}
          </button>
          <button
            autoFocus
            onClick={() => onResolve(true)}
            style={{
              padding: "6px 14px",
              background: destructive ? "#f87171" : "var(--accent)",
              border: "1px solid " + (destructive ? "#f87171" : "var(--accent)"),
              borderRadius: 4,
              color: destructive ? "#1a1a1a" : "var(--bg)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    portalEl
  );
}
