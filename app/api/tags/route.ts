import { NextResponse } from "next/server";
import { join } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";
import { renameTag, deleteTag, TodoValidationError } from "@/lib/todo-store";

const log = createLogger("api/tags");
const TODOS_FILE = join(homedir(), ".pi-web", "todos.json");

function validationResponse(err: TodoValidationError) {
  return NextResponse.json({ error: err.message }, { status: 400 });
}

// PATCH /api/tags  body: { from: string; to: string }
// Rename a tag globally. Returns { tag, affected }.
export async function PATCH(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      from?: unknown; to?: unknown;
    };
    if (typeof body.from !== "string") {
      return NextResponse.json({ error: "from must be a string" }, { status: 400 });
    }
    if (typeof body.to !== "string") {
      return NextResponse.json({ error: "to must be a string" }, { status: 400 });
    }
    const result = renameTag(TODOS_FILE, body.from, body.to);
    log.info("tag renamed", { from: body.from, to: result.tag, affected: result.affected, durationMs: elapsedMs(startedAt) });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TodoValidationError) return validationResponse(error);
    log.error("tag rename failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/tags  body: { tag: string }
// Remove a tag from every todo. Returns { tag, affected }.
export async function DELETE(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      tag?: unknown;
    };
    if (typeof body.tag !== "string") {
      return NextResponse.json({ error: "tag must be a string" }, { status: 400 });
    }
    const result = deleteTag(TODOS_FILE, body.tag);
    log.info("tag deleted", { tag: result.tag, affected: result.affected, durationMs: elapsedMs(startedAt) });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TodoValidationError) return validationResponse(error);
    log.error("tag delete failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
