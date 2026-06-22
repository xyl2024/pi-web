import { NextResponse } from "next/server";
import { join } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";
import { setTagColor, TodoValidationError } from "@/lib/todo-store";

const log = createLogger("api/tags-color");
const TODOS_FILE = join(homedir(), ".pi-web", "todos.json");

function validationResponse(err: TodoValidationError) {
  return NextResponse.json({ error: err.message }, { status: 400 });
}

// PATCH /api/tags/color  body: { tag: string; color: string | null }
// Set or clear a tag's color globally. Every `todo_tags` row whose
// `lower(tag)` matches is rewritten inside one transaction. Returns
// { tag, color, affected }.
export async function PATCH(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      tag?: unknown;
      color?: unknown;
    };
    if (typeof body.tag !== "string" || body.tag.trim().length === 0) {
      return NextResponse.json({ error: "tag must be a non-empty string" }, { status: 400 });
    }
    if (body.color !== null && (typeof body.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(body.color))) {
      return NextResponse.json(
        { error: "color must be a hex color like #rrggbb or null" },
        { status: 400 },
      );
    }
    const result = setTagColor(TODOS_FILE, body.tag, body.color as string | null);
    log.info("tag color set", {
      tag: result.tag,
      color: result.color,
      affected: result.affected,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TodoValidationError) return validationResponse(error);
    log.error("tag color set failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}