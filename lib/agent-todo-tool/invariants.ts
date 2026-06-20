/**
 * State transition table for agent tasks.
 *
 * `from` is the current status, `to` is the requested status. Anything not
 * listed here is rejected. Same-status transitions are always allowed (idempotent).
 */

import type { AgentTaskStatus } from "../agent-todo-tool-types";

export const TASK_STATUSES = ["pending", "in_progress", "completed", "deleted"] as const;

const TRANSITIONS: Record<AgentTaskStatus, readonly AgentTaskStatus[]> = {
  pending: ["in_progress", "completed", "deleted"],
  in_progress: ["pending", "completed", "deleted"],
  completed: ["deleted"],
  deleted: [],
};

export function isTransitionValid(
  from: AgentTaskStatus,
  to: AgentTaskStatus,
): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function transitionErrorMessage(
  from: AgentTaskStatus,
  to: AgentTaskStatus,
): string {
  return `Invalid status transition: ${from} -> ${to}`;
}