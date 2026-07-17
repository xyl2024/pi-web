/**
 * Custom Pi Agent tools for the pi-web todo list.
 *
 * These are registered as `customTools` on createAgentSession, so they only
 * exist inside pi-web sessions — they are NOT installed into native pi.
 *
 * Files touched: ~/.pi-web/todos.json, mutated in-process.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { join } from "path";
import { homedir } from "os";
import {
  listTodos,
  type Todo,
  type DeadlineFilter,
} from "./todo-store";

const TODOS_FILE = join(homedir(), ".pi-web", "todos.json");

export const TODO_TOOL_NAMES = ["todo_list"] as const;

export type TodoToolName = (typeof TODO_TOOL_NAMES)[number];

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

interface ListDetails {
  total: number;
  returned: number;
  truncated: boolean;
  todos: Todo[];
}

function fmtDate(epochMs?: number): string {
  if (epochMs === undefined) return "—";
  return new Date(epochMs).toISOString();
}

function fmtTodoLine(t: Todo): string {
  const check = t.done ? "[x]" : "[ ]";
  const deadline = t.deadline !== undefined ? `  (due ${fmtDate(t.deadline)})` : "";
  const tags = t.tags.length > 0 ? `  (tags: ${t.tags.map((tg) => tg.name).join(", ")})` : "";
  return `${check} ${t.title}${deadline}${tags}  [id=${t.id}]`;
}

function result<T>(text: string, details: T) {
  return { content: [{ type: "text" as const, text }], details };
}

function errResult<T>(message: string, details: T) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details,
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DeadlineFilterSchema = StringEnum(
  ["overdue", "today", "thisWeek", "noDeadline"] as const,
  { description: "Bucket by deadline relative to now (local time)." },
);

const ListParams = Type.Object({
  done: Type.Optional(
    Type.Boolean({
      description: "If true, return only completed todos. If false, only active. Omit for both.",
    }),
  ),
  search: Type.Optional(
    Type.String({
      description: "Case-insensitive substring filter on title and description.",
    }),
  ),
  deadlineFilter: Type.Optional(DeadlineFilterSchema),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Return only todos that have at least one of these tags (case-insensitive). Omit or pass [] to disable tag filtering.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Max items to return. Default ${DEFAULT_LIST_LIMIT}, capped at ${MAX_LIST_LIMIT}.`,
    }),
  ),
});


// ---------------------------------------------------------------------------
// Tool definitions — `defineTool` infers the params type from the schema, so
// the `execute` callback sees `Static<typeof XxxParams>` for free.
// ---------------------------------------------------------------------------

const todoListTool = defineTool<typeof ListParams, ListDetails>({
  name: "todo_list",
  label: "Todo List",
  description:
    "List todos in the user's pi-web todo list. Returns the most recent items first; completed items are listed by completion time. Use filters (done / search / deadlineFilter) to narrow. The 'id' field on each todo is needed for todo_update and todo_delete.",
  parameters: ListParams,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    try {
      const limit = Math.max(0, Math.min(params.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
      const total = listTodos(TODOS_FILE, {
        done: params.done,
        search: params.search,
        deadlineFilter: params.deadlineFilter as DeadlineFilter | undefined,
        tags: params.tags,
        limit: Number.MAX_SAFE_INTEGER,
      }).length;
      const todos = listTodos(TODOS_FILE, {
        done: params.done,
        search: params.search,
        deadlineFilter: params.deadlineFilter as DeadlineFilter | undefined,
        tags: params.tags,
        limit,
      });
      const returned = todos.length;
      const truncated = returned < total;
      const header = truncated
        ? `${returned} of ${total} todos (limited; raise limit to see more):`
        : total === 0
          ? "No todos match the current filters."
          : `${total} todo(s):`;
      const body = todos.map(fmtTodoLine).join("\n") || "(empty)";
      const text = `${header}\n${body}`;
      return result(text, { total, returned, truncated, todos });
    } catch (error) {
      return errResult(String(error), { total: 0, returned: 0, truncated: false, todos: [] });
    }
  },
});

export function buildTodoTools(enabled?: readonly string[]) {
  const all = [todoListTool];
  if (enabled === undefined) return all;
  const set = new Set(enabled);
  return all.filter((t) => set.has(t.name));
}
