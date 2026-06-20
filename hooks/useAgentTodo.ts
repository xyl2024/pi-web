"use client";

/**
 * `useAgentTodo` — read-side hook for the agent's task list.
 *
 * Implementation: simple polling. Each 1.5s we re-fetch the latest state from
 * `GET /api/agent/[id]/agent-todo` (an O(1) tail-read of the JSONL file).
 * React's `useEffect` dependency on `sessionId` is the entire session-lifecycle
 * story: when the user switches sessions, the effect cleanup stops the old
 * interval and the new effect starts a fresh one. No module-level store, no
 * listener registry, no race-condition guards — each `AgentTodoPanel` is the
 * sole owner of its own state.
 *
 * Why polling instead of SSE: the panel is a low-cadence view of agent working
 * memory (~<50 tasks, <1KB), 1.5s latency is imperceptible for a "what is the
 * agent doing" display, and polling sidesteps the entire listener/cleanup
 * lifecycle that made SSE over-engineered for this case.
 */

import { useEffect, useState } from "react";
import {
  EMPTY_STATE,
  countTasks,
  isStateEmpty,
  selectVisible,
  type AgentTask,
  type AgentTaskCounts,
} from "@/lib/agent-todo-tool-types";

const POLL_INTERVAL_MS = 1500;

export interface UseAgentTodoResult {
  /** Tasks filtered to non-deleted (tombstoned tasks are hidden). */
  tasks: readonly AgentTask[];
  /** True when there's nothing to render — caller should hide the panel. */
  empty: boolean;
  counts: AgentTaskCounts;
}

export function useAgentTodo(sessionId: string | null): UseAgentTodoResult {
  const [state, setState] = useState<{ tasks: AgentTask[]; nextId: number }>(EMPTY_STATE);

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;

    const poll = async () => {
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/agent-todo`);
        if (!alive || !res.ok) return;
        const data = await res.json() as { tasks?: AgentTask[]; nextId?: number };
        if (!alive) return;
        setState({
          tasks: Array.isArray(data.tasks) ? data.tasks : [],
          nextId: typeof data.nextId === "number" ? data.nextId : 1,
        });
      } catch {
        // Network errors are silent — next tick will retry.
      }
    };

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
      setState(EMPTY_STATE);
    };
  }, [sessionId]);

  const visible = selectVisible(state.tasks);
  return {
    tasks: visible,
    empty: isStateEmpty(state),
    counts: countTasks(visible),
  };
}

export { EMPTY_STATE };