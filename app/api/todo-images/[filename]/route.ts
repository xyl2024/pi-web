import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { createLogger, elapsedMs } from "@/lib/logger";
import { TODO_IMAGE_FILENAME_RE, mimeForTodoImageFilename } from "@/lib/todo-images-utils";

const log = createLogger("api/todo-images/[filename]");
const TODO_IMAGES_DIR = join(homedir(), ".pi-web", "todo_images");

// GET /api/todo-images/[filename]
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const startedAt = Date.now();
  try {
    const { filename } = await params;
    if (!TODO_IMAGE_FILENAME_RE.test(filename)) {
      return NextResponse.json({ error: "invalid filename" }, { status: 400 });
    }

    const filepath = resolve(join(TODO_IMAGES_DIR, filename));
    if (!filepath.startsWith(resolve(TODO_IMAGES_DIR) + "/") && filepath !== resolve(TODO_IMAGES_DIR)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    if (!existsSync(filepath)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const mime = mimeForTodoImageFilename(filename);
    const buffer = readFileSync(filepath);

    log.info("todo image served", { filename, size: buffer.length, durationMs: elapsedMs(startedAt) });
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    log.error("todo image serve failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
