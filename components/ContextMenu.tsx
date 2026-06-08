"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  key: string;
  label?: string;
  ariaLabel?: string;
  onSelect: () => void;
  destructive?: boolean;
  separatorBefore?: boolean;
  disabled?: boolean;
}

interface ContextMenuState {
  id: string;
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface ContextMenuContextValue {
  state: ContextMenuState | null;
  open: (args: { x: number; y: number; items: ContextMenuItem[] }) => void;
  close: () => void;
}

const ContextMenuContext = createContext<ContextMenuContextValue | null>(null);

let _idCounter = 0;
function nextId(): string {
  _idCounter += 1;
  return `ctx-${Date.now()}-${_idCounter}`;
}

const ESTIMATED_WIDTH = 220;
const ESTIMATED_HEIGHT_PER_ITEM = 24;
const EDGE_PADDING = 8;

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ContextMenuState | null>(null);
  const stateRef = useRef<ContextMenuState | null>(null);
  stateRef.current = state;

  const close = useCallback(() => {
    stateRef.current = null;
    setState(null);
  }, []);

  const open = useCallback((args: { x: number; y: number; items: ContextMenuItem[] }) => {
    // Clamp position to viewport
    const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
    const vh = typeof window !== "undefined" ? window.innerHeight : 768;
    const separators = args.items.filter((i) => i.separatorBefore).length;
    const totalH = args.items.length * ESTIMATED_HEIGHT_PER_ITEM + separators * 9;
    const x = Math.min(args.x, vw - ESTIMATED_WIDTH - EDGE_PADDING);
    const y = Math.min(args.y, vh - totalH - EDGE_PADDING);
    setState({ id: nextId(), x: Math.max(EDGE_PADDING, x), y: Math.max(EDGE_PADDING, y), items: args.items });
  }, []);

  // Close triggers: outside mousedown, ESC, scroll, resize
  useEffect(() => {
    if (!state) return;

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-pi-context-menu]")) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    const onScroll = () => close();
    const onResize = () => close();

    // Use capture so we get the event before any inner handlers
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize, true);
    };
  }, [state, close]);

  const value = useMemo<ContextMenuContextValue>(() => ({ state, open, close }), [state, open, close]);

  return (
    <ContextMenuContext.Provider value={value}>
      {children}
      {state && <ContextMenuView state={state} onItem={close} />}
    </ContextMenuContext.Provider>
  );
}

export function useContextMenu(): ContextMenuContextValue {
  const ctx = useContext(ContextMenuContext);
  if (!ctx) throw new Error("useContextMenu must be used within ContextMenuProvider");
  return ctx;
}

function ContextMenuView({ state, onItem }: { state: ContextMenuState; onItem: () => void }) {
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalEl(document.body);
  }, []);

  if (!portalEl) return null;

  return createPortal(
    <div
      data-pi-context-menu
      role="menu"
      style={{
        position: "fixed",
        left: state.x,
        top: state.y,
        zIndex: 10001,
        minWidth: 180,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 6px 20px rgba(0,0,0,0.32)",
        padding: 4,
        display: "flex",
        flexDirection: "column",
        gap: 1,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.items.map((it) => (
        <ContextMenuRow key={it.key} item={it} onPick={onItem} />
      ))}
    </div>,
    portalEl
  );
}

function ContextMenuRow({ item, onPick }: { item: ContextMenuItem; onPick: () => void }) {
  if (item.separatorBefore) {
    return (
      <>
        <div
          role="separator"
          style={{
            height: 1,
            background: "var(--border)",
            margin: "4px 4px",
          }}
        />
        <RowInner item={item} onPick={onPick} />
      </>
    );
  }
  return <RowInner item={item} onPick={onPick} />;
}

function RowInner({ item, onPick }: { item: ContextMenuItem; onPick: () => void }) {
  return (
    <div
      role="menuitem"
      aria-label={item.ariaLabel ?? item.label}
      aria-disabled={item.disabled}
      onMouseDown={(e) => {
        // Use mousedown to close before potential click handlers fire on items
        e.preventDefault();
        e.stopPropagation();
        if (item.disabled) return;
        item.onSelect();
        onPick();
      }}
      style={{
        padding: "5px 10px",
        fontSize: 12,
        color: item.disabled
          ? "var(--text-dim)"
          : item.destructive
            ? "#f87171"
            : "var(--text)",
        cursor: item.disabled ? "default" : "pointer",
        borderRadius: 4,
        userSelect: "none",
        background: "transparent",
      }}
      onMouseEnter={(e) => {
        if (!item.disabled) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {item.label}
    </div>
  );
}
