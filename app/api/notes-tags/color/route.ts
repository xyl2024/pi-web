import { NextResponse } from "next/server";
import { join } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";
import { setNoteTagColor, NoteValidationError } from "@/lib/notes-store";

const log = createLogger("api/notes-tags-color");
const NOTES_FILE = join(homedir(), ".pi-web", "notes.json");

function validationResponse(err: NoteValidationError) {
  return NextResponse.json({ error: err.message }, { status: 400 });
}

// PATCH /api/notes-tags/color  body: { tag: string; color: string | null }
// Set or clear a tag's color globally across all notes. Returns
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
    const result = setNoteTagColor(NOTES_FILE, body.tag, body.color as string | null);
    log.info("note tag color set", {
      tag: result.tag,
      color: result.color,
      affected: result.affected,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof NoteValidationError) return validationResponse(error);
    log.error("note tag color set failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}