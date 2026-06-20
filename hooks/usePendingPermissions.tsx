"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { PermissionDialog } from "@/components/PermissionDialog";

export interface PendingPermissionRequest {
  toolCallId: string;
  ruleName: string;
  command: string;
  /** Session id used when sending the decision back to the server. */
  sessionId: string;
}

export type Decision = "allow_once" | "allow_similar" | "deny";

interface PermissionContextValue {
  addRequest: (req: PendingPermissionRequest) => void;
  resolveRequest: (toolCallId: string, decision: Decision) => Promise<void>;
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

export function PermissionProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<PendingPermissionRequest[]>([]);
  // Mirror in a ref so async POSTs always see the latest queue when removing
  // by toolCallId, even if React state hasn't yet committed.
  const queueRef = useRef<PendingPermissionRequest[]>([]);
  queueRef.current = queue;

  const addRequest = useCallback((req: PendingPermissionRequest) => {
    setQueue((prev) => {
      if (prev.some((r) => r.toolCallId === req.toolCallId)) return prev;
      return [...prev, req];
    });
  }, []);

  const resolveRequest = useCallback(async (toolCallId: string, decision: Decision) => {
    const req = queueRef.current.find((r) => r.toolCallId === toolCallId);
    if (!req) return;
    setQueue((prev) => prev.filter((r) => r.toolCallId !== toolCallId));
    try {
      await fetch(`/api/agent/${encodeURIComponent(req.sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "permission_decision", toolCallId, decision }),
      });
    } catch {
      // Server already disconnected or wrapper destroyed — nothing to do.
    }
  }, []);

  const head = queue[0] ?? null;

  return (
    <PermissionContext.Provider value={{ addRequest, resolveRequest }}>
      {children}
      {head && (
        <PermissionDialog
          request={head}
          onDecide={(decision: Decision) => {
            void resolveRequest(head.toolCallId, decision);
          }}
        />
      )}
    </PermissionContext.Provider>
  );
}

export function usePendingPermissions(): PermissionContextValue {
  const ctx = useContext(PermissionContext);
  if (!ctx) throw new Error("usePendingPermissions must be used within PermissionProvider");
  return ctx;
}

/**
 * Imperative ref for places (like the SSE event handler inside useAgentSession)
 * where calling hooks is awkward. Always reflects the latest addRequest.
 */
export function usePendingPermissionsRef(): RefObject<PermissionContextValue | null> {
  const ctx = useContext(PermissionContext);
  const ref = useRef<PermissionContextValue | null>(ctx);
  useEffect(() => {
    ref.current = ctx;
  }, [ctx]);
  return ref;
}