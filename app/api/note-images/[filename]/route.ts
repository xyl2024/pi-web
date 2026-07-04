import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/note-images/[filename]");
const NOTE_IMAGES_DIR = join(homedir(), ".pi-web", "note_images");

// Mirror app/api/files/[...path]/route.ts
const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

// Strict whitelist: UUID v4 hex + limited image extensions. This is the
// only thing standing between us and a path-traversal attack, so be picky.
const FILENAME_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif)$/i;

// GET /api/note-images/[filename]
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const startedAt = Date.now();
  try {
    const { filename } = await params;
    if (!FILENAME_RE.test(filename)) {
      return NextResponse.json({ error: "invalid filename" }, { status: 400 });
    }

    const filepath = resolve(join(NOTE_IMAGES_DIR, filename));
    if (!filepath.startsWith(resolve(NOTE_IMAGES_DIR) + "/") && filepath !== resolve(NOTE_IMAGES_DIR)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    if (!existsSync(filepath)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const ext = filename.split(".").pop()!.toLowerCase();
    const mime = IMAGE_EXT_TO_MIME[ext] ?? "application/octet-stream";
    const buffer = readFileSync(filepath);

    log.info("note image served", { filename, size: buffer.length, durationMs: elapsedMs(startedAt) });
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    log.error("note image serve failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}