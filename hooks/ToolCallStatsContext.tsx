"use client";

import { createContext, useContext, useCallback, useRef, type ReactNode } from "react";

// ── Event types ──

export interface ToolCallStartEvent {
  type: "tool_start";
  toolCallId: string;
  toolName: string;
  timestamp: number;
}

export interface ToolCallEndEvent {
  type: "tool_end";
  toolCallId: string;
  isError: boolean;
  timestamp: number;
}

export interface ToolCallStatsReset {
  type: "reset";
}

export type ToolCallStatsEvent = ToolCallStartEvent | ToolCallEndEvent | ToolCallStatsReset;

// ── Dispatch type ──

export type ToolCallStatsDispatch = (event: ToolCallStatsEvent) => void;

// ── Context ──

interface ToolCallStatsContextValue {
  /** Called by useAgentSession to emit events */
  emit: ToolCallStatsDispatch;
  /** Called once by useToolCallStats to register its listener */
  register: (fn: ToolCallStatsDispatch) => void;
}

const ToolCallStatsContext = createContext<ToolCallStatsContextValue | null>(null);

export function ToolCallStatsProvider({ children }: { children: ReactNode }) {
  const listenerRef = useRef<ToolCallStatsDispatch | null>(null);

  const emit: ToolCallStatsDispatch = useCallback((event: ToolCallStatsEvent) => {
    listenerRef.current?.(event);
  }, []);

  const register = useCallback((fn: ToolCallStatsDispatch) => {
    listenerRef.current = fn;
  }, []);

  return (
    <ToolCallStatsContext.Provider value={{ emit, register }}>
      {children}
    </ToolCallStatsContext.Provider>
  );
}

/** Call this from useAgentSession to push tool lifecycle events into the stats hook. */
export function useToolCallStatsEmit(): ToolCallStatsDispatch {
  const ctx = useContext(ToolCallStatsContext);
  // Return a no-op if not wrapped (safe to call unconditionally)
  return ctx?.emit ?? (() => {});
}

/** Call this once from useToolCallStats to register its internal dispatch. */
export function useToolCallStatsRegister(fn: ToolCallStatsDispatch): void {
  const ctx = useContext(ToolCallStatsContext);
  const registeredRef = useRef(false);
  if (ctx && !registeredRef.current) {
    ctx.register(fn);
    registeredRef.current = true;
  }
}
