/**
 * Pure payload helpers backing the pi agent todo tools.
 *
 * Lives in its own module so it can be imported by tests (scripts/test-*.ts)
 * without transitively pulling in `@earendil-works/pi-ai` or `typebox`,
 * both of which are ESM-only and crash the CJS loader that tsx uses by
 * default. `lib/todo-tools.ts` re-exports these helpers and wraps them in
 * `defineTool` + `execute` (which is where the schema types live).
 */

import {
  listTodos,
  type Tag,
  type Todo,
} from "./todo-store";
import { extractTodoImageFilenames } from "./todo-images-utils";
import { mimeForTodoImageFilename } from "./todo-images-utils";
import { todoImageUrl } from "./todo-tools-url";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * The set of tool names exposed to the pi agent. Lives in this module so
 * tests can import it without pulling in `@earendil-works/pi-ai` /
 * `typebox` (ESM-only — would crash the tsx CJS loader). `lib/todo-tools.ts`
 * re-exports it for `lib/rpc-manager.ts` + the config routes.
 */
export const TODO_TOOL_NAMES = ["user_todos_list", "user_todo_description"] as const;

export type TodoToolName = (typeof TODO_TOOL_NAMES)[number];

// Cap the description text we echo into the SSE text channel. The full
// content is always available via `details.content` for programmatic
// consumers; this only protects the LLM context window from a 100 KB
// HTML payload.
export const MAX_DESC_TEXT = 4000;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ListItemStatus = "done" | "processing";

export interface ListItem {
  id: string;
  todo_name: string;
  status: ListItemStatus;
  create_time: number;
  due_time?: number;
  tags: Tag[];
}

export interface ListDetails {
  total: number;
  returned: number;
  truncated: boolean;
  todos: ListItem[];
}

export interface DescriptionImage {
  filename: string;
  url: string;
  mime: string;
}

export interface DescriptionDetails {
  id: string;
  content: string;
  images: DescriptionImage[];
}

export interface NotFoundDetails {
  error: "not_found";
  id: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function todoToListItem(t: Todo): ListItem {
  return {
    id: t.id,
    todo_name: t.title,
    status: t.done ? "done" : "processing",
    create_time: t.createdAt,
    due_time: t.deadline,
    tags: t.tags,
  };
}

export interface BuildDescriptionPayload {
  id: string;
  content: string;
  images: DescriptionImage[];
}

/**
 * Pure helper backing `user_todo_description`: extract image references from
 * the description, resolve each to an absolute URL + mime, and return the
 * payload. Exported so tests can call it directly.
 */
export function buildDescriptionPayload(todo: Todo): BuildDescriptionPayload {
  const rawContent = todo.description ?? "";
  const filenames = extractTodoImageFilenames(rawContent);
  const images: DescriptionImage[] = filenames.map((filename) => ({
    filename,
    url: todoImageUrl(filename),
    mime: mimeForTodoImageFilename(filename),
  }));
  return { id: todo.id, content: rawContent, images };
}

export function buildDescriptionEchoText(todo: Todo, payload: BuildDescriptionPayload): string {
  const truncated = payload.content.length > MAX_DESC_TEXT;
  const echoed = truncated
    ? `${payload.content.slice(0, MAX_DESC_TEXT)}…[truncated]`
    : payload.content;
  const header = `Todo: ${todo.title}  [id=${todo.id}]  (${payload.images.length} image${payload.images.length === 1 ? "" : "s"})`;
  if (payload.images.length > 0) return `${header}\n${echoed}`;
  if (payload.content.length > 0) return `${header}\n${echoed}`;
  return `${header}\n(description is empty)`;
}

export interface ListPayloadParams {
  status?: ListItemStatus | "all";
  tags?: string[];
  create_time_window?: { start?: number; end?: number };
  due_time_window?: { start?: number; end?: number };
  limit?: number;
}

export interface BuildListPayload {
  details: ListDetails;
  text: string;
}

function statusToDoneFilter(status: ListItemStatus | "all" | undefined): boolean | undefined {
  switch (status) {
    case "done":
      return true;
    case "processing":
      return false;
    case "all":
    case undefined:
      return undefined;
  }
}

function fmtDate(epochMs?: number): string {
  if (epochMs === undefined) return "—";
  return new Date(epochMs).toISOString();
}

function fmtListLine(item: ListItem): string {
  const check = item.status === "done" ? "[x]" : "[ ]";
  const due = item.due_time !== undefined ? `  (due ${fmtDate(item.due_time)})` : "";
  const tagPart = item.tags.length > 0 ? `  (tags: ${item.tags.map((t) => t.name).join(", ")})` : "";
  return `${check} ${item.todo_name}${due}${tagPart}  [id=${item.id}]`;
}

/**
 * Pure helper backing `user_todos_list`: apply the schema-shaped params to
 * `listTodos` and produce both the structured `details` and the LLM-facing
 * summary text. Exported so tests can call it directly. The optional
 * `now` indirection lets tests pin time-sensitive filters.
 */
export function buildListPayload(
  params: ListPayloadParams,
  now: () => number = Date.now,
): BuildListPayload {
  const limit = Math.max(0, Math.min(params.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
  const done = statusToDoneFilter(params.status);
  const createWindow = params.create_time_window;
  const dueWindow = params.due_time_window;

  const baseOpts = {
    done,
    tags: params.tags,
    createdAfter: createWindow?.start,
    createdBefore: createWindow?.end,
    deadlineAfter: dueWindow?.start,
    deadlineBefore: dueWindow?.end,
    now: now(),
  };

  const total = listTodos("", { ...baseOpts, limit: Number.MAX_SAFE_INTEGER }).length;
  const items = listTodos("", { ...baseOpts, limit }).map(todoToListItem);
  const returned = items.length;
  const truncated = returned < total;
  const header = truncated
    ? `${returned} of ${total} todos (limited; raise limit to see more):`
    : total === 0
      ? "No todos match the current filters."
      : `${total} todo(s):`;
  const body = items.map(fmtListLine).join("\n") || "(empty)";
  const text = `${header}\n${body}`;
  return { details: { total, returned, truncated, todos: items }, text };
}