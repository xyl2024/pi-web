import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import JSZip from "jszip";
import { createLogger, elapsedMs } from "@/lib/logger";
import { readTodos } from "@/lib/todo-store";
import { extractTodoImageFilenames } from "@/lib/todo-images-utils";

const log = createLogger("api/todos/[id]/export");
const TODOS_FILE = join(homedir(), ".pi-web", "todos.json");
const TODO_IMAGES_DIR = join(homedir(), ".pi-web", "todo_images");

// Build a filesystem-safe slug from the todo title. Keep ASCII letters/digits
// and CJK ideographs; collapse everything else into a single hyphen. Cap at
// 80 chars so the resulting zip filename stays well below OS limits even after
// adding ".zip".
function slugifyTitle(title: string, fallbackId: string): string {
  const cleaned = title
    .replace(/[^\p{L}\p{N}一-鿿]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : `todo-${fallbackId.slice(0, 8)}`;
}

// GET /api/todos/[id]/export
//
// Builds a zip whose root is a single folder named after a slug of the todo
// title:
//
//   <slug>/
//     <slug>.md         ← "# <title>\n\n<description>" with image URLs rewritten
//     images/<file>     ← every image referenced from the description
//
// If the description references no images, the images/ folder is omitted.
// Images missing from disk are logged and skipped — they shouldn't block the
// rest of the export.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const todos = readTodos(TODOS_FILE);
    const todo = todos.find((t) => t.id === id);
    if (!todo) {
      return NextResponse.json({ error: "todo not found" }, { status: 404 });
    }

    const slug = slugifyTitle(todo.title, todo.id);
    const description = todo.description ?? "";

    // Rewrite /api/todo-images/<file> → images/<file> in the markdown so the
    // exported bundle is self-contained.
    const rewrittenDescription = description.replace(
      /\/api\/todo-images\/([^)\s]+)/g,
      "images/$1",
    );
    const markdownBody = `# ${todo.title}\n\n${rewrittenDescription}`;

    const zip = new JSZip();
    const folder = zip.folder(slug);
    if (!folder) {
      // jszip only returns null if the name is invalid; slug is sanitized so
      // this should never trigger in practice.
      throw new Error("failed to create zip folder");
    }
    folder.file(`${slug}.md`, markdownBody);

    const filenames = extractTodoImageFilenames(description);
    const imagesRoot = resolve(TODO_IMAGES_DIR);
    let bundledImages = 0;
    let missingImages = 0;
    if (filenames.length > 0) {
      const imagesFolder = folder.folder("images");
      if (!imagesFolder) {
        throw new Error("failed to create images folder");
      }
      for (const filename of filenames) {
        const filepath = resolve(join(TODO_IMAGES_DIR, filename));
        if (
          !filepath.startsWith(imagesRoot + "/") &&
          filepath !== imagesRoot
        ) {
          log.warn("image path escaped images dir; skipping", { id, filename });
          missingImages++;
          continue;
        }
        if (!existsSync(filepath)) {
          log.warn("image missing on disk; skipping", { id, filename });
          missingImages++;
          continue;
        }
        try {
          const buffer = readFileSync(filepath);
          imagesFolder.file(filename, buffer);
          bundledImages++;
        } catch (error) {
          log.warn("image read failed; skipping", { id, filename, error });
          missingImages++;
        }
      }
    }

    const zipBuffer = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    log.info("todo exported", {
      id,
      slug,
      bundledImages,
      missingImages,
      bytes: zipBuffer.length,
      durationMs: elapsedMs(startedAt),
    });

    // Next's BodyInit typing doesn't list Uint8Array in this version even
    // though the runtime fetch impl accepts it; one targeted cast is cheaper
    // than wrapping the zip in a ReadableStream just to please the checker.
    return new NextResponse(zipBuffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(slug)}.zip`,
        "Content-Length": String(zipBuffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    log.error("todo export failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
