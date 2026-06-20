/**
 * Pure reducer for the `agent_todo` tool.
 *
 * `applyAgentTaskMutation(state, action, params)` validates the request,
 * mutates a copy of the state, and returns either a new state + a tagged
 * `op` describing what happened, or an `error` op with a human-readable
 * message. It never throws — callers get a tagged union.
 *
 * State semantics:
 * - `nextId` is monotonically increasing. `create` consumes one.
 * - `delete` is a tombstone: status flips to "deleted", the task is kept so
 *   that `blockedBy` references and audit history still resolve.
 * - `blockedBy` must reference existing (non-deleted) tasks, never self,
 *   and never form a cycle (transitively through the dependency graph).
 */

import {
  EMPTY_STATE,
  type AgentTask,
  type AgentTaskState,
  type AgentTodoAction,
} from "../agent-todo-tool-types";
import { isTransitionValid, transitionErrorMessage } from "./invariants";

export type AgentTodoOp =
  | { kind: "create"; task: AgentTask; state: AgentTaskState }
  | { kind: "update"; task: AgentTask; state: AgentTaskState }
  | { kind: "delete"; task: AgentTask; state: AgentTaskState }
  | { kind: "list"; state: AgentTaskState; tasks: AgentTask[] }
  | { kind: "get"; state: AgentTaskState; task: AgentTask }
  | { kind: "clear"; state: AgentTaskState }
  | { kind: "error"; message: string; state: AgentTaskState };

/**
 * Subset of tool params that the reducer inspects. Keeping the type loose
 * (rather than importing the TypeBox schema) keeps this module synchronous
 * and free of server-only SDK imports — the tool wrapper validates against
 * the schema before calling.
 */
export interface ReducerParams {
  // create
  subject?: string;
  blockedBy?: number[];

  // create + update
  description?: string;
  activeForm?: string;
  owner?: string;
  // metadata: null on update means "delete this key"; undefined means "leave alone"
  metadata?: Record<string, unknown> | null;

  // update (incremental)
  addBlockedBy?: number[];
  removeBlockedBy?: number[];

  // update / get / delete
  id?: number;
  status?: AgentTask["status"];

  // list
  includeDeleted?: boolean;
}

function normalizeBlockedBy(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
}

function withUpdatedMetadata(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (patch === null || patch === undefined) return current;
  const next = { ...(current ?? {}), ...patch };
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Return all tasks that transitively depend on `taskId` (i.e. list every
 * task whose `blockedBy` chain leads to `taskId`). Used for cycle detection.
 */
function downstreamBlockedBy(tasks: readonly AgentTask[], taskId: number): Set<number> {
  const dependents = new Set<number>();
  let added = true;
  while (added) {
    added = false;
    for (const t of tasks) {
      if (t.status === "deleted") continue;
      if (dependents.has(t.id)) continue;
      if (t.blockedBy && t.blockedBy.includes(taskId)) {
        dependents.add(t.id);
        taskId = t.id;
        added = true;
      }
    }
  }
  return dependents;
}

function wouldCreateCycle(
  tasks: readonly AgentTask[],
  selfId: number,
  newBlockedBy: readonly number[],
): boolean {
  for (const dep of newBlockedBy) {
    if (dep === selfId) return true;
    if (downstreamBlockedBy(tasks, dep).has(selfId)) return true;
  }
  return false;
}

function validateBlockedByTargets(
  tasks: readonly AgentTask[],
  blockedBy: readonly number[],
): string | null {
  const byId = new Map<number, AgentTask>();
  for (const t of tasks) byId.set(t.id, t);
  for (const id of blockedBy) {
    const dep = byId.get(id);
    if (!dep) return `blockedBy references non-existent task ${id}`;
    if (dep.status === "deleted") return `blockedBy references deleted task ${id}`;
  }
  return null;
}

export function applyAgentTaskMutation(
  state: AgentTaskState,
  action: AgentTodoAction,
  params: ReducerParams,
): AgentTodoOp {
  switch (action) {
    case "create": {
      if (typeof params.subject !== "string" || params.subject.trim().length === 0) {
        return { kind: "error", message: "subject is required for create", state };
      }
      const blockedBy = normalizeBlockedBy(params.blockedBy);
      if (blockedBy.length > 0) {
        const err = validateBlockedByTargets(state.tasks, blockedBy);
        if (err) return { kind: "error", message: err, state };
      }
      const id = state.nextId;
      const task: AgentTask = {
        id,
        subject: params.subject.trim(),
        status: "pending",
        ...(typeof params.description === "string" ? { description: params.description } : {}),
        ...(typeof params.activeForm === "string" ? { activeForm: params.activeForm } : {}),
        ...(typeof params.owner === "string" ? { owner: params.owner } : {}),
        ...(blockedBy.length > 0 ? { blockedBy } : {}),
        ...(params.metadata && typeof params.metadata === "object"
          ? { metadata: params.metadata as Record<string, unknown> }
          : {}),
      };
      const next: AgentTaskState = {
        tasks: [...state.tasks, task],
        nextId: state.nextId + 1,
      };
      return { kind: "create", task, state: next };
    }

    case "update": {
      if (typeof params.id !== "number") {
        return { kind: "error", message: "id is required for update", state };
      }
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx < 0) return { kind: "error", message: `task ${params.id} not found`, state };
      const current = state.tasks[idx];
      if (current.status === "deleted") {
        return { kind: "error", message: `task ${params.id} is deleted`, state };
      }

      const next: AgentTask = { ...current };
      if (typeof params.subject === "string") next.subject = params.subject.trim();
      if (typeof params.description === "string") next.description = params.description;
      if (typeof params.activeForm === "string") next.activeForm = params.activeForm;
      if (typeof params.owner === "string") next.owner = params.owner;

      if (params.metadata !== undefined) {
        next.metadata = withUpdatedMetadata(current.metadata, params.metadata);
      }

      const nextBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
      let blockedByChanged = false;
      if (Array.isArray(params.addBlockedBy)) {
        for (const id of normalizeBlockedBy(params.addBlockedBy)) {
          if (!nextBlockedBy.includes(id)) {
            nextBlockedBy.push(id);
            blockedByChanged = true;
          }
        }
      }
      if (Array.isArray(params.removeBlockedBy)) {
        for (const id of normalizeBlockedBy(params.removeBlockedBy)) {
          const i = nextBlockedBy.indexOf(id);
          if (i !== -1) {
            nextBlockedBy.splice(i, 1);
            blockedByChanged = true;
          }
        }
      }

      if (blockedByChanged) {
        if (nextBlockedBy.length > 0) {
          const err = validateBlockedByTargets(state.tasks, nextBlockedBy);
          if (err) return { kind: "error", message: err, state };
          if (wouldCreateCycle(state.tasks, current.id, nextBlockedBy)) {
            return { kind: "error", message: "blockedBy would create a cycle", state };
          }
        }
        next.blockedBy = nextBlockedBy.length > 0 ? nextBlockedBy : undefined;
      }

      if (typeof params.status === "string") {
        if (!isTransitionValid(current.status, params.status)) {
          return {
            kind: "error",
            message: transitionErrorMessage(current.status, params.status),
            state,
          };
        }
        next.status = params.status;
      }

      const tasks = state.tasks.slice();
      tasks[idx] = next;
      return { kind: "update", task: next, state: { tasks, nextId: state.nextId } };
    }

    case "delete": {
      if (typeof params.id !== "number") {
        return { kind: "error", message: "id is required for delete", state };
      }
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx < 0) return { kind: "error", message: `task ${params.id} not found`, state };
      const current = state.tasks[idx];
      if (current.status === "deleted") {
        // Idempotent: already deleted, still success.
        return { kind: "delete", task: current, state };
      }
      const tombstone: AgentTask = { ...current, status: "deleted" };
      const tasks = state.tasks.slice();
      tasks[idx] = tombstone;
      return { kind: "delete", task: tombstone, state: { tasks, nextId: state.nextId } };
    }

    case "list": {
      const includeDeleted = params.includeDeleted === true;
      let filtered = state.tasks;
      if (typeof params.status === "string") {
        filtered = filtered.filter((t) => t.status === params.status);
      }
      if (!includeDeleted) {
        filtered = filtered.filter((t) => t.status !== "deleted");
      }
      return { kind: "list", state, tasks: filtered };
    }

    case "get": {
      if (typeof params.id !== "number") {
        return { kind: "error", message: "id is required for get", state };
      }
      const task = state.tasks.find((t) => t.id === params.id);
      if (!task) return { kind: "error", message: `task ${params.id} not found`, state };
      return { kind: "get", state, task };
    }

    case "clear": {
      return { kind: "clear", state: EMPTY_STATE };
    }

    default:
      return {
        kind: "error",
        message: `Unknown action: ${String(action)}`,
        state,
      };
  }
}