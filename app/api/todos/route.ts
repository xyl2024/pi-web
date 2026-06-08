import { NextResponse } from "next/server";
import { join } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";
import { readTodos, writeTodos, generateTodoId, type Todo } from "@/lib/todo-store";

const log = createLogger("api/todos");
const TODOS_FILE = join(homedir(), ".pi-web", "todos.json");

const MAX_TITLE_LENGTH = 200;

function findIndex(todos: Todo[], id: string): number {
  return todos.findIndex((t) => t.id === id);
}

// GET /api/todos
export async function GET() {
  const startedAt = Date.now();
  try {
    const todos = readTodos(TODOS_FILE);
    log.info("todos read", { count: todos.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ todos });
  } catch (error) {
    log.error("todos read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/todos  body: { title: string; description?: string }
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as { title?: unknown; description?: unknown };
    if (typeof body.title !== "string") {
      return NextResponse.json({ error: "title must be a string" }, { status: 400 });
    }
    const title = body.title.trim();
    if (title.length === 0) {
      return NextResponse.json({ error: "title cannot be empty" }, { status: 400 });
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return NextResponse.json({ error: "title is too long" }, { status: 400 });
    }
    const description = typeof body.description === "string" ? body.description : undefined;

    const todos = readTodos(TODOS_FILE);
    const todo: Todo = {
      id: generateTodoId(),
      title,
      description,
      done: false,
      createdAt: Date.now(),
    };
    const next = [todo, ...todos];
    writeTodos(TODOS_FILE, next);
    log.info("todo created", { id: todo.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ todo });
  } catch (error) {
    log.error("todo create failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/todos  body: { id: string; title?: string; description?: string; done?: boolean }
export async function PATCH(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      id?: unknown; title?: unknown; description?: unknown; done?: unknown;
    };
    if (typeof body.id !== "string") {
      return NextResponse.json({ error: "id must be a string" }, { status: 400 });
    }
    const todos = readTodos(TODOS_FILE);
    const idx = findIndex(todos, body.id);
    if (idx === -1) {
      return NextResponse.json({ error: "todo not found" }, { status: 404 });
    }
    const prev = todos[idx];
    const next: Todo = { ...prev };

    if (body.title !== undefined) {
      if (typeof body.title !== "string") {
        return NextResponse.json({ error: "title must be a string" }, { status: 400 });
      }
      const t = body.title.trim();
      if (t.length === 0) {
        return NextResponse.json({ error: "title cannot be empty" }, { status: 400 });
      }
      if (t.length > MAX_TITLE_LENGTH) {
        return NextResponse.json({ error: "title is too long" }, { status: 400 });
      }
      next.title = t;
    }
    if (body.description !== undefined) {
      if (typeof body.description !== "string") {
        return NextResponse.json({ error: "description must be a string" }, { status: 400 });
      }
      next.description = body.description;
    }
    if (body.done !== undefined) {
      if (typeof body.done !== "boolean") {
        return NextResponse.json({ error: "done must be a boolean" }, { status: 400 });
      }
      // Server manages completedAt: false→true stamps, true→false clears
      if (body.done !== prev.done) {
        next.done = body.done;
        next.completedAt = body.done ? Date.now() : undefined;
      }
    }

    const updated = [...todos];
    updated[idx] = next;
    writeTodos(TODOS_FILE, updated);
    log.info("todo updated", { id: next.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ todo: next });
  } catch (error) {
    log.error("todo update failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/todos?id=...
export async function DELETE(req: Request) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id query param required" }, { status: 400 });
    }
    const todos = readTodos(TODOS_FILE);
    const idx = findIndex(todos, id);
    if (idx === -1) {
      return NextResponse.json({ error: "todo not found" }, { status: 404 });
    }
    const next = [...todos.slice(0, idx), ...todos.slice(idx + 1)];
    writeTodos(TODOS_FILE, next);
    log.info("todo deleted", { id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error("todo delete failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
