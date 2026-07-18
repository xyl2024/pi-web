/**
 * Custom Pi Agent tools for the pi-web todo list.
 *
 * Two read-only tools are exposed to the agent:
 * - `user_todos_list`: lightweight summary (no description, no images),
 *   filterable by status / tags / created / due time windows.
 * - `user_todo_description`: full description + image URLs for a single
 *   todo by id.
 *
 * The agent never creates, updates, or deletes todos — those operations
 * remain user-side only. Custom tools are registered on `createAgentSession`
 * (see lib/rpc-manager.ts) so they only exist inside pi-web sessions.
 *
 * Files touched: ~/.pi-web/todos.db (via lib/todo-store.ts). No writes
 * are performed by these tools.
 *
 * The pure payload builders live in `lib/todo-tools-payloads.ts` so tests
 * can import them without transitively pulling in `@earendil-works/pi-ai`
 * (ESM-only — would crash the tsx CJS loader). This module re-exports the
 * payload helpers for the convenience of any future server-side caller.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { getTodoById } from "./todo-store";
import {
  TODO_TOOL_NAMES,
  buildDescriptionEchoText,
  buildDescriptionPayload,
  buildListPayload,
  type DescriptionDetails,
  type ListDetails,
  type NotFoundDetails,
  type TodoToolName,
} from "./todo-tools-payloads";

export { TODO_TOOL_NAMES };
export type { TodoToolName };

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const StatusSchema = StringEnum(["done", "processing", "all"] as const, {
  description: '"done" = completed only, "processing" = active only, "all" = both. Defaults to "all".',
});

const WindowSchema = Type.Object(
  {
    start: Type.Optional(
      Type.Number({ description: "Inclusive lower bound in epoch ms. Omit to leave the lower side unbounded." }),
    ),
    end: Type.Optional(
      Type.Number({ description: "Exclusive upper bound in epoch ms. Omit to leave the upper side unbounded." }),
    ),
  },
  { additionalProperties: false },
);

const ListParams = Type.Object(
  {
    status: Type.Optional(StatusSchema),
    tags: Type.Optional(
      Type.Array(Type.String(), {
        description: "OR-semantics, case-insensitive. Match todos that have at least one of these tags. Omit or pass [] to disable.",
      }),
    ),
    create_time_window: Type.Optional(WindowSchema),
    due_time_window: Type.Optional(WindowSchema),
    limit: Type.Optional(
      Type.Number({
        description: `Max items to return. Default ${DEFAULT_LIST_LIMIT}, capped at ${MAX_LIST_LIMIT}.`,
      }),
    ),
  },
  { additionalProperties: false },
);

const DescriptionParams = Type.Object(
  {
    id: Type.String({
      description: "Todo id returned by user_todos_list. Required.",
      minLength: 1,
    }),
  },
  { additionalProperties: false },
);

// Re-export payload types so consumers can `import { ListDetails } from
// "@/lib/todo-tools"` without learning about the inner split.
export type { ListDetails, DescriptionDetails, NotFoundDetails } from "./todo-tools-payloads";
export {
  buildDescriptionPayload,
  buildDescriptionEchoText,
  buildListPayload,
  todoToListItem,
} from "./todo-tools-payloads";

// ---------------------------------------------------------------------------
// Tool result wrappers (SDK-shaped)
// ---------------------------------------------------------------------------

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
// Tool definitions
// ---------------------------------------------------------------------------

const userTodosListTool = defineTool<typeof ListParams, ListDetails>({
  name: "user_todos_list",
  label: "User Todos List",
  description:
    "Look up the user's pi-web todos and return a lightweight summary (no description, no images). " +
    "Each item exposes id, todo_name (title), status ('done' or 'processing'), create_time and due_time (epoch ms), and tags. " +
    "Filters: status (default 'all'); tags (OR-semantics, case-insensitive); create_time_window / due_time_window ({ start?, end? }) " +
    "in epoch ms with half-open [start, end) semantics. Either side of a window may be omitted. " +
    "due_time_window excludes todos without a deadline (they cannot satisfy a time bound). " +
    "Sort: active todos first by soonest deadline (todos without a deadline sink to the bottom), then completed by most recently completed. " +
    "Use the returned id with user_todo_description to fetch the full description and embedded images. " +
    `Pass limit (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}) if you expect a large result; the response includes a 'truncated' flag.`,
  parameters: ListParams,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    try {
      const payload = buildListPayload(params);
      return result(payload.text, payload.details);
    } catch (error) {
      return errResult(String(error), { total: 0, returned: 0, truncated: false, todos: [] });
    }
  },
});

const userTodoDescriptionTool = defineTool<typeof DescriptionParams, DescriptionDetails | NotFoundDetails>({
  name: "user_todo_description",
  label: "User Todo Description",
  description:
    "Fetch the full description of a single todo by id. " +
    "Returns content (the description text, may contain markdown image references like ![alt](/api/todo-images/<filename>)) " +
    "and images (an array of { filename, url, mime } for every image referenced in the description — url is an absolute URL with origin). " +
    "If id does not match any todo, returns an error result with details.error = 'not_found' instead of throwing.",
  parameters: DescriptionParams,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    const todo = getTodoById(params.id);
    if (!todo) {
      return errResult(`Todo not found: ${params.id}`, {
        error: "not_found" as const,
        id: params.id,
      });
    }
    const payload = buildDescriptionPayload(todo);
    const text = buildDescriptionEchoText(todo, payload);
    return result(text, payload);
  },
});

export function buildTodoTools(enabled?: readonly string[]) {
  const all = [userTodosListTool, userTodoDescriptionTool];
  if (enabled === undefined) return all;
  const set = new Set(enabled);
  return all.filter((t) => set.has(t.name));
}