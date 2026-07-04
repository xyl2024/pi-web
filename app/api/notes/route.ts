import { NextResponse } from "next/server";
import { join } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";
import {
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  NoteValidationError,
  NoteNotFoundError,
  type Tag,
} from "@/lib/notes-store";

const log = createLogger("api/notes");
// File-path sentinel kept for source compatibility with todo-store.ts's
// signature; the SQLite handle lives at ~/.pi-web/notes.db (see notes-db.ts).
const NOTES_FILE = join(homedir(), ".pi-web", "notes.json");

function validationResponse(err: NoteValidationError) {
  return NextResponse.json({ error: err.message }, { status: 400 });
}

// GET /api/notes?search=...&tags=a,b,c
export async function GET(req: Request) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const search = url.searchParams.get("search") ?? undefined;
    const tagsParam = url.searchParams.get("tags");
    const tags = tagsParam ? tagsParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const notes = listNotes(NOTES_FILE, {
      search: search ?? undefined,
      tags: tags && tags.length > 0 ? tags : undefined,
    });
    log.info("notes read", { count: notes.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ notes });
  } catch (error) {
    log.error("notes read failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/notes  body: { title?: string; content?: string; tags?: string[] }
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      title?: unknown; content?: unknown; tags?: unknown;
    };
    // Preserve pre-refactor behavior: silently drop non-string content on create.
    const content = typeof body.content === "string" ? body.content : undefined;
    const note = createNote(NOTES_FILE, {
      title: body.title as string | undefined,
      content,
      tags: Array.isArray(body.tags) ? (body.tags as (Tag | string)[]) : undefined,
    });
    log.info("note created", { id: note.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ note });
  } catch (error) {
    if (error instanceof NoteValidationError) return validationResponse(error);
    log.error("note create failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/notes  body: { id: string; title?: string; content?: string; tags?: string[] | null }
export async function PATCH(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      id?: unknown; title?: unknown; content?: unknown; tags?: unknown;
    };
    if (typeof body.id !== "string") {
      return NextResponse.json({ error: "id must be a string" }, { status: 400 });
    }
    const note = updateNote(NOTES_FILE, body.id, {
      title: body.title as string | undefined,
      content: body.content as string | undefined,
      tags: body.tags === null
        ? null
        : Array.isArray(body.tags)
          ? (body.tags as (Tag | string)[])
          : undefined,
    });
    log.info("note updated", { id: note.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ note });
  } catch (error) {
    if (error instanceof NoteValidationError) return validationResponse(error);
    if (error instanceof NoteNotFoundError) {
      return NextResponse.json({ error: "note not found" }, { status: 404 });
    }
    log.error("note update failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/notes?id=...
export async function DELETE(req: Request) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id query param required" }, { status: 400 });
    }
    deleteNote(NOTES_FILE, id);
    log.info("note deleted", { id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof NoteValidationError) return validationResponse(error);
    if (error instanceof NoteNotFoundError) {
      return NextResponse.json({ error: "note not found" }, { status: 404 });
    }
    log.error("note delete failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}