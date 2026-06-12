import { NextResponse } from "next/server";
import { join } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";
import {
  listTodos,
  createTodo,
  updateTodo,
  deleteTodo,
  TodoValidationError,
  TodoNotFoundError,
} from "@/lib/todo-store";

const log = createLogger("api/todos");
const TODOS_FILE = join(homedir(), ".pi-web", "todos.json");

function validationResponse(err: TodoValidationError) {
  return NextResponse.json({ error: err.message }, { status: 400 });
}

// GET /api/todos
export async function GET() {
  const startedAt = Date.now();
  try {
    const todos = listTodos(TODOS_FILE);
    log.info("todos read", { count: todos.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ todos });
  } catch (error) {
    log.error("todos read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/todos  body: { title: string; description?: string; deadline?: number; tags?: string[] }
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      title?: unknown; description?: unknown; deadline?: unknown; tags?: unknown;
    };
    // Preserve pre-refactor behavior: silently drop non-string description on create.
    const description = typeof body.description === "string" ? body.description : undefined;
    const todo = createTodo(TODOS_FILE, {
      title: body.title as string,
      description,
      deadline: body.deadline as number | undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
    });
    log.info("todo created", { id: todo.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ todo });
  } catch (error) {
    if (error instanceof TodoValidationError) return validationResponse(error);
    log.error("todo create failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/todos  body: { id: string; title?: string; description?: string; done?: boolean; deadline?: number | null; tags?: string[] | null }
export async function PATCH(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      id?: unknown; title?: unknown; description?: unknown; done?: unknown; deadline?: unknown; tags?: unknown;
    };
    if (typeof body.id !== "string") {
      return NextResponse.json({ error: "id must be a string" }, { status: 400 });
    }
    const todo = updateTodo(TODOS_FILE, body.id, {
      title: body.title as string | undefined,
      description: body.description as string | undefined,
      done: body.done as boolean | undefined,
      deadline: body.deadline as number | null | undefined,
      tags: body.tags === null
        ? null
        : Array.isArray(body.tags)
          ? (body.tags as string[])
          : undefined,
    });
    log.info("todo updated", { id: todo.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ todo });
  } catch (error) {
    if (error instanceof TodoValidationError) return validationResponse(error);
    if (error instanceof TodoNotFoundError) {
      return NextResponse.json({ error: "todo not found" }, { status: 404 });
    }
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
    deleteTodo(TODOS_FILE, id);
    log.info("todo deleted", { id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TodoValidationError) return validationResponse(error);
    if (error instanceof TodoNotFoundError) {
      return NextResponse.json({ error: "todo not found" }, { status: 404 });
    }
    log.error("todo delete failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
