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
  createTodo,
  updateTodo,
  deleteTodo,
  listTodos,
  TodoValidationError,
  TodoNotFoundError,
  type Todo,
  type DeadlineFilter,
} from "./todo-store";

const TODOS_FILE = join(homedir(), ".pi-web", "todos.json");

export const TODO_TOOL_NAMES = [
  "todo_list",
  "todo_create",
  "todo_update",
  "todo_delete",
] as const;

export type TodoToolName = (typeof TODO_TOOL_NAMES)[number];

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

interface ListDetails {
  total: number;
  returned: number;
  truncated: boolean;
  todos: Todo[];
}

interface TodoDetails {
  todo: Todo;
}

interface DeleteDetails {
  id: string;
  deleted: boolean;
}

function fmtDate(epochMs?: number): string {
  if (epochMs === undefined) return "—";
  return new Date(epochMs).toISOString();
}

function fmtTodoLine(t: Todo): string {
  const check = t.done ? "[x]" : "[ ]";
  const deadline = t.deadline !== undefined ? `  (due ${fmtDate(t.deadline)})` : "";
  const tags = t.tags.length > 0 ? `  (tags: ${t.tags.join(", ")})` : "";
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

const CreateParams = Type.Object({
  title: Type.String({ description: "Todo title (1-200 chars, trimmed)." }),
  description: Type.Optional(
    Type.String({ description: "Optional markdown description." }),
  ),
  deadline: Type.Optional(
    Type.Number({ description: "Optional deadline as ms since epoch (local end-of-day recommended)." }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional tag list. Trimmed, deduped case-insensitively.",
    }),
  ),
});

const UpdateParams = Type.Object({
  id: Type.String({ description: "The id of the todo to update." }),
  title: Type.Optional(Type.String({ description: "New title." })),
  description: Type.Optional(
    Type.Union(
      [Type.String(), Type.Null()],
      { description: "New description, or null to clear it." },
    ),
  ),
  done: Type.Optional(
    Type.Boolean({
      description: "Mark completed (true) or active (false). Server manages completedAt.",
    }),
  ),
  deadline: Type.Optional(
    Type.Union(
      [Type.Number(), Type.Null()],
      { description: "New deadline as ms since epoch, or null to clear it." },
    ),
  ),
  tags: Type.Optional(
    Type.Union(
      [Type.Array(Type.String()), Type.Null()],
      { description: "Replace the tag list, or null to clear all tags." },
    ),
  ),
});

const DeleteParams = Type.Object({
  id: Type.String({ description: "The id of the todo to delete." }),
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

const todoCreateTool = defineTool<typeof CreateParams, TodoDetails>({
  name: "todo_create",
  label: "Todo Create",
  description: "Create a new todo in the user's pi-web todo list. Returns the created todo with its assigned id.",
  parameters: CreateParams,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    try {
      const todo = createTodo(TODOS_FILE, {
        title: params.title,
        description: params.description,
        deadline: params.deadline,
        tags: params.tags,
      });
      return result(`Created todo: ${fmtTodoLine(todo)}`, { todo });
    } catch (error) {
      const message = error instanceof TodoValidationError ? error.message : String(error);
      return errResult(message, { todo: undefined as unknown as Todo });
    }
  },
});

const todoUpdateTool = defineTool<typeof UpdateParams, TodoDetails>({
  name: "todo_update",
  label: "Todo Update",
  description:
    "Update an existing todo in the user's pi-web todo list by id. Any subset of title / description / done / deadline may be provided. Pass null for description or deadline to clear them. Server manages the completedAt timestamp when 'done' changes.",
  parameters: UpdateParams,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    try {
      // Normalize "null" -> undefined for description (no clear semantics in our model).
      const description = params.description === null
        ? undefined
        : params.description;
      // For deadline and tags, null IS the clear signal — pass through unchanged.
      const todo = updateTodo(TODOS_FILE, params.id, {
        title: params.title,
        description,
        done: params.done,
        deadline: params.deadline,
        tags: params.tags,
      });
      return result(`Updated: ${fmtTodoLine(todo)}`, { todo });
    } catch (error) {
      let message: string;
      if (error instanceof TodoValidationError) message = error.message;
      else if (error instanceof TodoNotFoundError) message = `todo ${params.id} not found`;
      else message = String(error);
      return errResult(message, { todo: undefined as unknown as Todo });
    }
  },
});

const todoDeleteTool = defineTool<typeof DeleteParams, DeleteDetails>({
  name: "todo_delete",
  label: "Todo Delete",
  description: "Delete a todo from the user's pi-web todo list by id. Returns an error if the id does not exist.",
  parameters: DeleteParams,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    try {
      deleteTodo(TODOS_FILE, params.id);
      return result(`Deleted todo ${params.id}`, { id: params.id, deleted: true });
    } catch (error) {
      let message: string;
      if (error instanceof TodoNotFoundError) message = `todo ${params.id} not found`;
      else if (error instanceof TodoValidationError) message = error.message;
      else message = String(error);
      return errResult(message, { id: params.id, deleted: false });
    }
  },
});

export function buildTodoTools(enabled?: readonly string[]) {
  const all = [todoListTool, todoCreateTool, todoUpdateTool, todoDeleteTool];
  if (enabled === undefined) return all;
  const set = new Set(enabled);
  return all.filter((t) => set.has(t.name));
}
