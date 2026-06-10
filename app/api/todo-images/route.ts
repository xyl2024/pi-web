import { NextResponse } from "next/server";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/todo-images");
const TODO_IMAGES_DIR = join(homedir(), ".pi-web", "todo_images");
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

// Mirror the image ext set used by app/api/files/[...path]/route.ts
// so generated filenames are recognised by the serve route's mime map.
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/avif": "avif",
};

function pickExt(mime: string): string {
  const known = MIME_TO_EXT[mime];
  if (known) return known;
  // Fallback: take the subtype verbatim, after a sanity filter.
  const subtype = mime.split("/")[1] ?? "";
  return subtype.replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
}

// POST /api/todo-images  body: multipart/form-data, field "file"
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file field is required" }, { status: 400 });
    }
    if (!file.type.startsWith("image/")) {
      return NextResponse.json({ error: "file must be an image" }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "file is empty" }, { status: 400 });
    }
    if (file.size > MAX_IMAGE_SIZE) {
      return NextResponse.json(
        { error: `file too large (max ${MAX_IMAGE_SIZE} bytes)` },
        { status: 400 },
      );
    }

    const ext = pickExt(file.type);
    const filename = `${randomUUID()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    mkdirSync(TODO_IMAGES_DIR, { recursive: true });
    writeFileSync(join(TODO_IMAGES_DIR, filename), buffer);

    log.info("todo image uploaded", {
      filename,
      size: file.size,
      mime: file.type,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ url: `/api/todo-images/${filename}`, filename });
  } catch (error) {
    log.error("todo image upload failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
