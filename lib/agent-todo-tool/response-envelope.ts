/**
 * Assembles the tool result envelope (`{ content, details }`) from the
 * reducer's tagged `op`. Keeps the tool wrapper focused on side effects
 * (storage, SSE emission) and the reducer pure.
 */

import type { AgentTodoAction, AgentTask, AgentTaskState, AgentTodoDetails } from "../agent-todo-tool-types";
import type { AgentTodoOp } from "./reducer";

export interface AgentTodoToolResult {
  content: [{ type: "text"; text: string }];
  details: AgentTodoDetails;
}

function makeDetails(
  action: AgentTodoAction,
  params: Record<string, unknown>,
  state: AgentTaskState,
  tasks: AgentTask[],
  error?: string,
): AgentTodoDetails {
  return {
    action,
    params,
    tasks,
    nextId: state.nextId,
    ...(error !== undefined ? { error } : {}),
  };
}

function fmtTask(t: AgentTask): string {
  return `[${t.status}] #${t.id} ${t.subject}`;
}

export function buildToolResult(
  action: AgentTodoAction,
  params: Record<string, unknown>,
  op: AgentTodoOp,
): AgentTodoToolResult {
  if (op.kind === "error") {
    return {
      content: [{ type: "text" as const, text: `Error: ${op.message}` }],
      details: makeDetails(action, params, op.state, op.state.tasks, op.message),
    };
  }

  if (op.kind === "create") {
    return {
      content: [{ type: "text" as const, text: `Created task: ${fmtTask(op.task)}` }],
      details: makeDetails(action, params, op.state, [op.task]),
    };
  }

  if (op.kind === "update") {
    return {
      content: [{ type: "text" as const, text: `Updated task: ${fmtTask(op.task)}` }],
      details: makeDetails(action, params, op.state, [op.task]),
    };
  }

  if (op.kind === "delete") {
    return {
      content: [{ type: "text" as const, text: `Deleted task #${op.task.id}` }],
      details: makeDetails(action, params, op.state, [op.task]),
    };
  }

  if (op.kind === "get") {
    return {
      content: [{ type: "text" as const, text: fmtTask(op.task) }],
      details: makeDetails(action, params, op.state, [op.task]),
    };
  }

  if (op.kind === "list") {
    const visible = op.tasks.filter((t) => t.status !== "deleted");
    if (visible.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No tasks." }],
        details: makeDetails(action, params, op.state, op.tasks),
      };
    }
    const header = `${visible.length} task(s):`;
    const body = visible.map(fmtTask).join("\n");
    return {
      content: [{ type: "text" as const, text: `${header}\n${body}` }],
      details: makeDetails(action, params, op.state, op.tasks),
    };
  }

  // clear
  return {
    content: [{ type: "text" as const, text: "Cleared all tasks." }],
    details: makeDetails(action, params, op.state, []),
  };
}