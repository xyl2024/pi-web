/**
 * `agent_todo` — single custom Pi tool, action-dispatched.
 *
 * The model invokes one of `create | update | list | get | delete | clear`
 * in each call. The wrapper:
 *   1. reads the current task state from `~/.pi-web/agent-todo/<sid>.jsonl`,
 *   2. runs the pure reducer to produce a new state,
 *   3. appends an audit entry to the JSONL file (with fsync),
 *   4. emits an `agent_todo_state` event to in-process listeners,
 *   5. returns the standard `{ content, details }` envelope to pi.
 *
 * IMPORTANT: This file imports `@earendil-works/pi-coding-agent`, which
 * transitively pulls in server-only Node modules. Client code that needs
 * the tool name or types must import from `./agent-todo-tool-types` instead.
 */

import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  AGENT_TODO_TOOL_NAME,
  type AgentTodoDetails,
  type AgentTaskState,
  type AgentTodoLogEntry,
} from "./agent-todo-tool-types";
import { applyAgentTaskMutation, type ReducerParams } from "./agent-todo-tool/reducer";
import { buildToolResult } from "./agent-todo-tool/response-envelope";
import {
  appendAgentTodoEntry,
  readAgentTodoState,
} from "./agent-todo-store";
import { createLogger } from "./logger";

export { AGENT_TODO_TOOL_NAME };
export type { AgentTodoAction, AgentTask, AgentTaskState, AgentTodoDetails, AgentTodoLogEntry } from "./agent-todo-tool-types";
export { countTasks, selectVisible, selectByStatus, isStateEmpty } from "./agent-todo-tool-types";

const log = createLogger("agent-todo-tool");

const AgentTodoParams = Type.Object({
  action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const, {
    description: "Which operation to perform. create/update/list/get/delete/clear.",
  }),

  // create
  subject: Type.Optional(
    Type.String({
      description: "Task title (required for create). Short, imperative, e.g. 'Research rpiv-todo replay'.",
    }),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.Number(), { description: "Initial blockedBy ids (create only)." }),
  ),

  // create + update
  description: Type.Optional(Type.String({ description: "Long-form description." })),
  activeForm: Type.Optional(
    Type.String({
      description: "Present-continuous label shown while in_progress, e.g. 'reading rpiv-todo source'.",
    }),
  ),
  owner: Type.Optional(Type.String({ description: "Owning agent or sub-agent name." })),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Arbitrary metadata. On update, pass null to delete a key.",
    }),
  ),

  // update (incremental)
  addBlockedBy: Type.Optional(
    Type.Array(Type.Number(), { description: "Add these ids to blockedBy (update only)." }),
  ),
  removeBlockedBy: Type.Optional(
    Type.Array(Type.Number(), { description: "Remove these ids from blockedBy (update only)." }),
  ),

  // update / get / delete
  id: Type.Optional(
    Type.Number({ description: "Task id (required for update, get, delete)." }),
  ),
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
      description: "Target status (update). Filter (list).",
    }),
  ),

  // list
  includeDeleted: Type.Optional(
    Type.Boolean({ description: "Include tombstoned tasks in list output. Default false." }),
  ),
});

type AgentTodoParamsType = Static<typeof AgentTodoParams>;

function paramsToReducerParams(params: AgentTodoParamsType): ReducerParams {
  return {
    ...(params.subject !== undefined ? { subject: params.subject } : {}),
    ...(params.blockedBy !== undefined ? { blockedBy: params.blockedBy } : {}),
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
    ...(params.owner !== undefined ? { owner: params.owner } : {}),
    ...(params.metadata !== undefined
      ? { metadata: params.metadata as Record<string, unknown> | null }
      : {}),
    ...(params.addBlockedBy !== undefined ? { addBlockedBy: params.addBlockedBy } : {}),
    ...(params.removeBlockedBy !== undefined ? { removeBlockedBy: params.removeBlockedBy } : {}),
    ...(params.id !== undefined ? { id: params.id } : {}),
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.includeDeleted !== undefined ? { includeDeleted: params.includeDeleted } : {}),
  };
}

function paramsForLog(params: AgentTodoParamsType): Record<string, unknown> {
  // Strip empty optional fields so the audit row stays compact.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export const agentTodoTool = defineTool<typeof AgentTodoParams, AgentTodoDetails>({
  name: AGENT_TODO_TOOL_NAME,
  label: "Agent Todo",
  description:
    "Manage an internal task list for multi-step work. Create tasks, mark them in_progress before starting, completed when done. Use blockedBy for dependencies. Status is a 4-state machine: pending -> in_progress -> completed, plus deleted as a tombstone. Single tool, dispatch on `action`.",
  parameters: AgentTodoParams,
  executionMode: "sequential",
  promptSnippet: "Manage a task list to track multi-step progress.",
  promptGuidelines: [
    "Use `agent_todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
    "When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task should be in_progress at a time.",
    "Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
    "Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
    "Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
    "list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
    "Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
  ],
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const action = params.action;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) {
      return buildToolResult(action, paramsForLog(params), {
        kind: "error",
        message: "agent_todo: no session id available in tool context",
        state: { tasks: [], nextId: 1 },
      });
    }

    let current: AgentTaskState;
    try {
      current = readAgentTodoState(sessionId);
    } catch (error) {
      log.warn("agent_todo read state failed", { sessionId, error });
      return buildToolResult(action, paramsForLog(params), {
        kind: "error",
        message: `failed to read state: ${error instanceof Error ? error.message : String(error)}`,
        state: { tasks: [], nextId: 1 },
      });
    }

    const op = applyAgentTaskMutation(current, action, paramsToReducerParams(params));
    const finalState = op.kind === "error" ? current : op.state;
    const errorMessage = op.kind === "error" ? op.message : undefined;

    // Single commit point: append + fsync. Failures here abort the action —
    // we return an error result and never advance the file state.
    const entry: AgentTodoLogEntry = {
      v: 1,
      ts: Date.now(),
      sessionId,
      action,
      params: paramsForLog(params),
      stateAfter: finalState,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
    };
    try {
      appendAgentTodoEntry(sessionId, entry);
    } catch (error) {
      log.warn("agent_todo append failed", { sessionId, error });
      return buildToolResult(action, paramsForLog(params), {
        kind: "error",
        message: `failed to persist state: ${error instanceof Error ? error.message : String(error)}`,
        state: current,
      });
    }

    // The frontend polls GET /api/agent/[id]/agent-todo — no in-process
    // broadcast needed; the file is the source of truth and the next poll
    // tick will pick up `finalState`.
    return buildToolResult(action, paramsForLog(params), op);
  },
});

export function buildAgentTodoTool() {
  return [agentTodoTool];
}