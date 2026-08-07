"use client";

/**
 * `useAgentTodo` — read-side hook for the agent's task list.
 *
 * Implementation: adaptive polling with change-skip. Each poll we re-fetch
 * the latest state from `GET /api/agent/[id]/agent-todo` (an O(1) tail-read
 * of the JSONL file) and compute a cheap fingerprint over the panel's
 * render-relevant fields. When the fingerprint matches the previous one,
 * we skip the `setState` (no re-render) and slow the next interval to
 * `IDLE_POLL_INTERVAL_MS`; when it differs, we update state and poll again
 * after `ACTIVE_POLL_INTERVAL_MS`. This keeps the panel responsive while the
 * agent is actively mutating tasks, and reduces idle-time request volume
 * ~5x once the state is stable.
 *
 * React's `useEffect` dependency on `sessionId` is the entire session-lifecycle
 * story: when the user switches sessions, the effect cleanup cancels the
 * pending timeout, clears the fingerprint, and resets the state; the new
 * effect starts a fresh chain. If the global `custom_tools.enabled` setting
 * has not loaded yet or disables `agent_todo`, the effect stays idle so the
 * frontend does not keep hitting an endpoint for a disabled tool and the
 * panel does not briefly render stale task state. No module-level store,
 * no listener registry — each `AgentTodoPanel` is the sole owner of its
 * own state.
 *
 * Why polling instead of SSE: the panel is a low-cadence view of agent working
 * memory (~<50 tasks, <1KB), 1.5s latency is imperceptible for a "what is the
 * agent doing" display, and polling sidesteps the entire listener/cleanup
 * lifecycle that made SSE over-engineered for this case.
 */

import { useEffect, useRef, useState } from "react";
import { useSettings } from "@/hooks/settingsStore";
import {
  AGENT_TODO_TOOL_NAME,
  EMPTY_STATE,
  countTasks,
  isStateEmpty,
  selectVisible,
  type AgentTask,
  type AgentTaskCounts,
} from "@/lib/agent-todo-tool-types";

/**
 * Active polling interval — used when the last response indicates state
 * changed (or for the first poll). Keeps the panel responsive while the
 * agent is actively mutating tasks.
 */
const ACTIVE_POLL_INTERVAL_MS = 1500;

/**
 * Idle polling interval — used when the last response matches the previous
 * fingerprint. Reduces idle-time request volume ~5x while keeping the panel
 * fresh enough for "what is the agent doing" display.
 */
const IDLE_POLL_INTERVAL_MS = 8000;

export interface UseAgentTodoResult {
  /** Tasks filtered to non-deleted (tombstoned tasks are hidden). */
  tasks: readonly AgentTask[];
  /** True when there's nothing to render — caller should hide the panel. */
  empty: boolean;
  counts: AgentTaskCounts;
  /** True when the global custom tool setting currently allows polling/rendering. */
  enabled: boolean;
}

/**
 * Cheap fingerprint over the panel's render-relevant fields: `nextId` (the
 * task-creation counter) plus per-task id/status/subject/activeForm. The
 * panel does not render `description` / `metadata` / `blockedBy`, so changes
 * to those fields are intentionally ignored — a re-render would be wasted.
 * `<50` tasks makes string concat fast enough; this is not a security hash.
 */
function computeAgentTodoFingerprint(
  tasks: readonly AgentTask[],
  nextId: number,
): string {
  let fp = `${nextId}:`;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    fp += `${t.id}/${t.status}/${t.subject}/${t.activeForm ?? ""};`;
  }
  return fp;
}

export function useAgentTodo(sessionId: string | null): UseAgentTodoResult {
  const settings = useSettings();
  const agentTodoEnabled = settings?.custom_tools.enabled.includes(AGENT_TODO_TOOL_NAME) === true;
  const [state, setState] = useState<{ tasks: AgentTask[]; nextId: number }>(EMPTY_STATE);
  // Stable across renders; cleared in the effect cleanup so a session switch
  // (or enabled-toggle) re-detects the first poll as a change.
  const lastFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId || !agentTodoEnabled) {
      setState(EMPTY_STATE);
      lastFingerprintRef.current = null;
      return;
    }
    let alive = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (!alive) return;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/agent-todo`);
        if (!alive) return;
        if (!res.ok) {
          // Server returned non-2xx — retry on active interval; we don't know
          // whether state changed, so we can't safely switch to IDLE.
          timeoutId = setTimeout(poll, ACTIVE_POLL_INTERVAL_MS);
          return;
        }
        const data = await res.json() as { tasks?: AgentTask[]; nextId?: number };
        if (!alive) return;
        const newTasks = Array.isArray(data.tasks) ? data.tasks : [];
        const newNextId = typeof data.nextId === "number" ? data.nextId : 1;
        const newFingerprint = computeAgentTodoFingerprint(newTasks, newNextId);
        const changed = lastFingerprintRef.current !== newFingerprint;
        lastFingerprintRef.current = newFingerprint;

        if (changed) {
          setState({ tasks: newTasks, nextId: newNextId });
        }
        const nextDelay = changed ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
        timeoutId = setTimeout(poll, nextDelay);
      } catch {
        if (!alive) return;
        // Network error — retry on active interval.
        timeoutId = setTimeout(poll, ACTIVE_POLL_INTERVAL_MS);
      }
    };

    poll();
    return () => {
      alive = false;
      if (timeoutId) clearTimeout(timeoutId);
      setState(EMPTY_STATE);
      lastFingerprintRef.current = null;
    };
  }, [sessionId, agentTodoEnabled]);

  const visible = selectVisible(state.tasks);
  return {
    tasks: visible,
    empty: isStateEmpty(state),
    counts: countTasks(visible),
    enabled: agentTodoEnabled,
  };
}

export { EMPTY_STATE };
