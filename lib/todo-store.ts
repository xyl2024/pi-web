import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface Todo {
  id: string;
  title: string;
  description?: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
  deadline?: number;
  tags: string[];
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_TAG_LENGTH = 50;

export type DeadlineFilter = "overdue" | "today" | "thisWeek" | "noDeadline";

export interface TodoCreateInput {
  title: string;
  description?: string;
  deadline?: number;
  tags?: string[];
}

export interface TodoUpdateInput {
  title?: string;
  description?: string;
  done?: boolean;
  deadline?: number | null;
  tags?: string[] | null;
}

export interface TodoListOptions {
  done?: boolean;
  search?: string;
  deadlineFilter?: DeadlineFilter;
  tags?: string[];
  limit?: number;
  now?: number;
}

export class TodoValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "TodoValidationError";
  }
}

export class TodoNotFoundError extends Error {
  constructor(id: string) {
    super("todo not found");
    this.name = "TodoNotFoundError";
    this.id = id;
  }
  public readonly id: string;
}

function isTodo(v: unknown): v is Todo {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.title === "string" &&
    typeof o.done === "boolean" &&
    typeof o.createdAt === "number" &&
    (o.description === undefined || typeof o.description === "string") &&
    (o.completedAt === undefined || typeof o.completedAt === "number") &&
    (o.deadline === undefined || typeof o.deadline === "number") &&
    (o.tags === undefined || (Array.isArray(o.tags) && o.tags.every((t) => typeof t === "string")))
  );
}

export function readTodos(filePath: string): Todo[] {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter(isTodo).map((t) => ({ ...t, tags: t.tags ?? [] }));
  } catch {
    return [];
  }
}

export function writeTodos(filePath: string, todos: Todo[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(todos, null, 2), "utf-8");
}

export function generateTodoId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function findIndex(todos: Todo[], id: string): number {
  return todos.findIndex((t) => t.id === id);
}

function validateTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new TodoValidationError("title must be a string", "title");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TodoValidationError("title cannot be empty", "title");
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new TodoValidationError("title is too long", "title");
  }
  return trimmed;
}

function validateOptionalDeadline(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TodoValidationError("deadline must be a number", "deadline");
  }
  return value;
}

/**
 * Normalize a tag list: trim each entry, drop empties, dedupe case-insensitively
 * (preserving the first occurrence's original casing). Used at every write site
 * so the stored array is always canonical.
 */
export function normalizeTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TodoValidationError("tags must be an array of strings", "tags");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new TodoValidationError("tags must be an array of strings", "tags");
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_TAG_LENGTH) {
      throw new TodoValidationError("tag is too long", "tags");
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function createTodo(filePath: string, input: TodoCreateInput): Todo {
  const title = validateTitle(input.title);
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new TodoValidationError("description must be a string", "description");
  }
  const description = input.description;
  const deadline = validateOptionalDeadline(input.deadline);
  const tags = normalizeTags(input.tags);

  const todos = readTodos(filePath);
  const todo: Todo = {
    id: generateTodoId(),
    title,
    description,
    done: false,
    createdAt: Date.now(),
    deadline,
    tags,
  };
  writeTodos(filePath, [todo, ...todos]);
  return todo;
}

export function updateTodo(filePath: string, id: string, patch: TodoUpdateInput): Todo {
  if (typeof id !== "string") {
    throw new TodoValidationError("id must be a string", "id");
  }
  const todos = readTodos(filePath);
  const idx = findIndex(todos, id);
  if (idx === -1) throw new TodoNotFoundError(id);
  const prev = todos[idx];
  const next: Todo = { ...prev };

  if (patch.title !== undefined) {
    next.title = validateTitle(patch.title);
  }
  if (patch.description !== undefined) {
    if (typeof patch.description !== "string") {
      throw new TodoValidationError("description must be a string", "description");
    }
    next.description = patch.description;
  }
  if (patch.done !== undefined) {
    if (typeof patch.done !== "boolean") {
      throw new TodoValidationError("done must be a boolean", "done");
    }
    // Server manages completedAt: false→true stamps, true→false clears.
    if (patch.done !== prev.done) {
      next.done = patch.done;
      next.completedAt = patch.done ? Date.now() : undefined;
    }
  }
  if (patch.deadline !== undefined) {
    if (patch.deadline === null) {
      delete next.deadline;
    } else if (typeof patch.deadline !== "number" || !Number.isFinite(patch.deadline)) {
      throw new TodoValidationError("deadline must be a number or null", "deadline");
    } else {
      next.deadline = patch.deadline;
    }
  }
  if (patch.tags !== undefined) {
    if (patch.tags === null) {
      next.tags = [];
    } else {
      next.tags = normalizeTags(patch.tags);
    }
  }

  const updated = [...todos];
  updated[idx] = next;
  writeTodos(filePath, updated);
  return next;
}

export function deleteTodo(filePath: string, id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new TodoValidationError("id is required", "id");
  }
  const todos = readTodos(filePath);
  const idx = findIndex(todos, id);
  if (idx === -1) throw new TodoNotFoundError(id);
  const next = [...todos.slice(0, idx), ...todos.slice(idx + 1)];
  writeTodos(filePath, next);
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * List todos with optional filters. Filter semantics mirror the UI in
 * components/TodoPanel.tsx so the agent sees the same buckets the user does.
 */
export function listTodos(filePath: string, opts: TodoListOptions = {}): Todo[] {
  const todos = readTodos(filePath);
  const now = opts.now ?? Date.now();
  const startOfToday = startOfDay(now);
  const startOfTomorrow = startOfToday + 24 * 60 * 60 * 1000;
  // "本周内" = 本周一 ~ 本周日（含今天）。endOfThisWeek 取"下周一 0 点"。
  const dayOfWeek = new Date(now).getDay();
  const daysToEndOfWeek = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const endOfThisWeek = startOfToday + daysToEndOfWeek * 24 * 60 * 60 * 1000;
  const term = opts.search?.trim().toLowerCase() ?? "";

  const filtered = todos.filter((x) => {
    if (opts.done !== undefined && x.done !== opts.done) return false;
    switch (opts.deadlineFilter) {
      case undefined:
        break;
      case "overdue":
        if (x.done || x.deadline === undefined || x.deadline >= startOfToday) return false;
        break;
      case "today":
        if (x.done || x.deadline === undefined || x.deadline < startOfToday || x.deadline >= startOfTomorrow) return false;
        break;
      case "thisWeek":
        if (x.done || x.deadline === undefined || x.deadline < startOfToday || x.deadline >= endOfThisWeek) return false;
        break;
      case "noDeadline":
        if (x.deadline !== undefined) return false;
        break;
    }
    if (term) {
      const inTitle = x.title.toLowerCase().includes(term);
      const inDesc = (x.description ?? "").toLowerCase().includes(term);
      if (!inTitle && !inDesc) return false;
    }
    if (opts.tags && opts.tags.length > 0) {
      const wanted = new Set(opts.tags.map((t) => t.toLowerCase()));
      if (!x.tags.some((t) => wanted.has(t.toLowerCase()))) return false;
    }
    return true;
  });

  const sortKey: keyof Todo = opts.done === true ? "completedAt" : "createdAt";
  filtered.sort((a, b) => {
    if (opts.done === undefined && a.done !== b.done) {
      return a.done ? 1 : -1; // active first, done last
    }
    const av = (a[sortKey] as number | undefined) ?? 0;
    const bv = (b[sortKey] as number | undefined) ?? 0;
    return bv - av;
  });

  if (typeof opts.limit === "number" && opts.limit >= 0) {
    return filtered.slice(0, opts.limit);
  }
  return filtered;
}
