/**
 * Client-safe constants, types, and pure helpers for the `agent_todo` tool.
 *
 * This file MUST NOT import `@earendil-works/pi-coding-agent` or any
 * server-only Node module — it's imported by client components
 * (`components/AgentTodoPanel.tsx`, `hooks/useAgentTodo.tsx`) to match
 * the tool name and types without pulling server-only code into the
 * browser bundle.
 */

export const AGENT_TODO_TOOL_NAME = "agent_todo";

/** Action discriminator for the single `agent_todo` tool. */
export type AgentTodoAction =
  | "create"
  | "update"
  | "list"
  | "get"
  | "delete"
  | "clear";

export type AgentTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface AgentTask {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: AgentTaskStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentTaskState {
  tasks: AgentTask[];
  nextId: number;
}

export interface AgentTodoDetails {
  action: AgentTodoAction;
  params: Record<string, unknown>;
  tasks: AgentTask[];
  nextId: number;
  error?: string;
}

/** One row of `~/.pi-web/agent-todo/<sessionId>.jsonl`. */
export interface AgentTodoLogEntry {
  v: 1;
  ts: number;
  sessionId: string;
  action: AgentTodoAction;
  params: Record<string, unknown>;
  stateAfter: AgentTaskState;
  error?: string;
}

export const EMPTY_STATE: AgentTaskState = { tasks: [], nextId: 1 };

export interface AgentTaskCounts {
  pending: number;
  inProgress: number;
  completed: number;
  total: number;
}

/** True iff the task is visible to the agent (i.e. not tombstoned). */
export function isVisible(task: AgentTask): boolean {
  return task.status !== "deleted";
}

/** Drop tombstoned tasks. */
export function selectVisible(tasks: readonly AgentTask[]): AgentTask[] {
  return tasks.filter(isVisible);
}

/** Filter by status; useful for "list" with a filter. */
export function selectByStatus(
  tasks: readonly AgentTask[],
  status: AgentTaskStatus,
): AgentTask[] {
  return tasks.filter((t) => t.status === status);
}

/** Counts used in the panel header. */
export function countTasks(tasks: readonly AgentTask[]): AgentTaskCounts {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const t of tasks) {
    if (t.status === "pending") pending++;
    else if (t.status === "in_progress") inProgress++;
    else if (t.status === "completed") completed++;
  }
  return { pending, inProgress, completed, total: pending + inProgress + completed };
}

/** True when there is nothing to render. */
export function isStateEmpty(state: AgentTaskState): boolean {
  return selectVisible(state.tasks).length === 0;
}