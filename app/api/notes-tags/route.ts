import { NextResponse } from "next/server";
import { join } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";
import {
  renameNoteTag,
  deleteNoteTag,
  NoteValidationError,
} from "@/lib/notes-store";

const log = createLogger("api/notes-tags");
const NOTES_FILE = join(homedir(), ".pi-web", "notes.json");

function validationResponse(err: NoteValidationError) {
  return NextResponse.json({ error: err.message }, { status: 400 });
}

// PATCH /api/notes-tags  body: { from: string; to: string }
// Rename a tag globally across all notes. Returns { tag, affected }.
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
    const result = renameNoteTag(NOTES_FILE, body.from, body.to);
    log.info("note tag renamed", { from: body.from, to: result.tag, affected: result.affected, durationMs: elapsedMs(startedAt) });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof NoteValidationError) return validationResponse(error);
    log.error("note tag rename failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/notes-tags  body: { tag: string }
// Remove a tag from every note. Returns { tag, affected }.
export async function DELETE(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      tag?: unknown;
    };
    if (typeof body.tag !== "string") {
      return NextResponse.json({ error: "tag must be a string" }, { status: 400 });
    }
    const result = deleteNoteTag(NOTES_FILE, body.tag);
    log.info("note tag deleted", { tag: result.tag, affected: result.affected, durationMs: elapsedMs(startedAt) });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof NoteValidationError) return validationResponse(error);
    log.error("note tag delete failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}