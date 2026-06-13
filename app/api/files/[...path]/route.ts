import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { createLogger, elapsedMs } from "@/lib/logger";
import { validateFileName } from "@/lib/file-name";
import {
  filePathFromSegments,
  getAllowedRoots,
  invalidateAllowedRootsCache,
  isPathAllowed,
} from "@/lib/file-access";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store", ".git",
]);

const IGNORED_SUFFIXES = [".pyc"];

const TEXT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const PDF_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
const log = createLogger("api/files");

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

const AUDIO_EXT_TO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  weba: "audio/webm",
  webm: "audio/webm",
};

const PDF_EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
};

function getExt(filePath: string): string {
  const ext = path.basename(filePath).toLowerCase().split(".").pop() ?? "";
  return ext;
}

function getImageMime(filePath: string): string | null {
  return IMAGE_EXT_TO_MIME[getExt(filePath)] ?? null;
}

function getAudioMime(filePath: string): string | null {
  return AUDIO_EXT_TO_MIME[getExt(filePath)] ?? null;
}

function getPdfMime(filePath: string): string | null {
  return PDF_EXT_TO_MIME[getExt(filePath)] ?? null;
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  html: "html", htm: "html", css: "css", scss: "css", less: "css",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl",
  env: "bash", gitignore: "bash", txt: "text",
};

function getLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  // Special full-name matches
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function jsonOk(data: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json({ ok: true, ...data }, { status });
}

function createFileBodyStream(filePath: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  const fileStream = fs.createReadStream(filePath, range);
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      fileStream.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          closed = true;
          fileStream.destroy();
        }
      });
      fileStream.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The browser may cancel media probes before the file stream ends.
        }
      });
      fileStream.once("error", (error) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(error);
        } catch {
          // The response was already abandoned by the client.
        }
      });
    },
    cancel() {
      closed = true;
      fileStream.destroy();
    },
  });
}

function streamFile(filePath: string, stat: fs.Stats, contentType: string, rangeHeader: string | null): Response {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "Accept-Ranges": "bytes",
  };

  if (!rangeHeader) {
    return new Response(createFileBodyStream(filePath), {
      headers: {
        ...headers,
        "Content-Length": String(stat.size),
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(stat.size - suffixLength, 0);
    end = stat.size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  end = Math.min(end, stat.size - 1);
  const chunkSize = end - start + 1;
  return new Response(createFileBodyStream(filePath, { start, end }), {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const startedAt = Date.now();
  try {
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);
    const type = request.nextUrl.searchParams.get("type") ?? "list";
    log.debug("file request received", { type, path: filePath });

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(filePath, allowedRoots)) {
      log.warn("file request denied", { type, path: filePath, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      log.warn("file request not found", { type, path: filePath, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (type === "read") {
      if (!stat.isFile()) {
        log.warn("file read rejected", { path: filePath, reason: "not a file", durationMs: elapsedMs(startedAt) });
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const imageMime = getImageMime(filePath);
      if (imageMime) {
        if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
          log.warn("image read rejected", { path: filePath, size: stat.size, durationMs: elapsedMs(startedAt) });
          return NextResponse.json({ error: "Image too large (>10MB)" }, { status: 413 });
        }
        log.info("image read streamed", {
          path: filePath,
          size: stat.size,
          contentType: imageMime,
          range: request.headers.get("range") ?? undefined,
          durationMs: elapsedMs(startedAt),
        });
        return streamFile(filePath, stat, imageMime, request.headers.get("range"));
      }
      const audioMime = getAudioMime(filePath);
      if (audioMime) {
        log.info("audio read streamed", {
          path: filePath,
          size: stat.size,
          contentType: audioMime,
          range: request.headers.get("range") ?? undefined,
          durationMs: elapsedMs(startedAt),
        });
        return streamFile(filePath, stat, audioMime, request.headers.get("range"));
      }
      const pdfMime = getPdfMime(filePath);
      if (pdfMime) {
        if (stat.size > PDF_PREVIEW_MAX_BYTES) {
          log.warn("pdf read rejected", { path: filePath, size: stat.size, durationMs: elapsedMs(startedAt) });
          return NextResponse.json({ error: "PDF too large (>50MB)" }, { status: 413 });
        }
        log.info("pdf read streamed", {
          path: filePath,
          size: stat.size,
          contentType: pdfMime,
          range: request.headers.get("range") ?? undefined,
          durationMs: elapsedMs(startedAt),
        });
        return streamFile(filePath, stat, pdfMime, request.headers.get("range"));
      }
      if (stat.size > TEXT_PREVIEW_MAX_BYTES) {
        log.warn("text read rejected", { path: filePath, size: stat.size, durationMs: elapsedMs(startedAt) });
        return NextResponse.json({ error: "File too large for preview (>256KB)" }, { status: 413 });
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const language = getLanguage(filePath);
      log.info("text file read", {
        path: filePath,
        size: stat.size,
        language,
        durationMs: elapsedMs(startedAt),
      });
      return NextResponse.json({ content, language, size: stat.size });
    }

    if (type === "watch") {
      if (!stat.isFile()) {
        log.warn("file watch rejected", { path: filePath, reason: "not a file", durationMs: elapsedMs(startedAt) });
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      let watcher: fs.FSWatcher | null = null;
      const stream = new ReadableStream({
        start(controller) {
          const send = (eventName: string, data: Record<string, unknown>) => {
            const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
            try {
              controller.enqueue(new TextEncoder().encode(payload));
            } catch {
              // client disconnected
            }
          };
          // Send initial ping so client knows connection is live
          send("connected", { filePath });
          try {
            watcher = fs.watch(filePath, () => {
              try {
                const s = fs.statSync(filePath);
                send("change", { mtime: s.mtime.toISOString(), size: s.size });
              } catch {
                send("change", { mtime: new Date().toISOString(), size: 0 });
              }
            });
            watcher.on("error", () => {
              log.warn("file watch error", { path: filePath, durationMs: elapsedMs(startedAt) });
              try { controller.close(); } catch { /* ignore */ }
            });
          } catch {
            log.warn("file watch failed to start", { path: filePath, durationMs: elapsedMs(startedAt) });
            send("error", { message: "Failed to watch file" });
            controller.close();
          }
        },
        cancel() {
          try { watcher?.close(); } catch { /* ignore */ }
          log.info("file watch closed", { path: filePath, durationMs: elapsedMs(startedAt) });
        },
      });
      log.info("file watch connected", { path: filePath, durationMs: elapsedMs(startedAt) });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // type === "list"
    if (!stat.isDirectory()) {
      log.warn("directory list rejected", { path: filePath, reason: "not a directory", durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }

    const names = fs.readdirSync(filePath);
    const entries = names
      .filter((name) => !IGNORED_NAMES.has(name) && !IGNORED_SUFFIXES.some((s) => name.endsWith(s)))
      .map((name) => {
        const full = path.join(filePath, name);
        try {
          const s = fs.statSync(full);
          return {
            name,
            isDir: s.isDirectory(),
            size: s.isFile() ? s.size : 0,
            modified: s.mtime.toISOString(),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => {
        // Dirs first, then files, both alphabetically
        if (a!.isDir !== b!.isDir) return a!.isDir ? -1 : 1;
        return a!.name.localeCompare(b!.name);
      });

    log.info("directory listed", {
      path: filePath,
      entryCount: entries.length,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ entries, path: filePath });
  } catch (error) {
    log.error("file request failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const startedAt = Date.now();
  try {
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);
    log.debug("file write request received", { path: filePath });

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(filePath, allowedRoots)) {
      log.warn("file write denied", { path: filePath, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      log.warn("file write target not found", { path: filePath, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (!stat.isFile()) {
      log.warn("file write rejected", { path: filePath, reason: "not a file", durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "Not a file" }, { status: 400 });
    }

    let body: { content?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "Missing or invalid 'content' field" }, { status: 400 });
    }

    fs.writeFileSync(filePath, body.content, "utf-8");

    log.info("file written", {
      path: filePath,
      size: body.content.length,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ ok: true, size: body.content.length });
  } catch (error) {
    log.error("file write failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const startedAt = Date.now();
  try {
    const { path: segments } = await params;
    const parentPath = filePathFromSegments(segments);
    const op = request.nextUrl.searchParams.get("type") ?? "create";
    log.debug("file mutation received", { op, parent: parentPath });

    if (op !== "mkdir" && op !== "create") {
      return jsonError("Invalid POST type", 400);
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(parentPath, allowedRoots)) {
      log.warn("file mutation denied", { op, parent: parentPath, durationMs: elapsedMs(startedAt) });
      return jsonError("Access denied", 403);
    }

    let body: { name?: string; content?: string; recursive?: boolean };
    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid JSON body", 400);
    }
    if (typeof body.name !== "string") {
      return jsonError("Missing 'name' field", 400);
    }

    const v = validateFileName(body.name);
    if (!v.ok) {
      return jsonError(v.message, 400);
    }
    const name = v.name;

    if (IGNORED_NAMES.has(name) || IGNORED_SUFFIXES.some((s) => name.endsWith(s))) {
      return jsonError("Cannot create ignored directory", 400);
    }

    // Parent must exist and be a directory
    let parentStat: fs.Stats;
    try {
      parentStat = fs.statSync(parentPath);
    } catch {
      return jsonError("Parent not found", 404);
    }
    if (!parentStat.isDirectory()) {
      return jsonError("Parent is not a directory", 400);
    }

    const target = path.join(parentPath, name);
    if (!isPathAllowed(target, allowedRoots)) {
      return jsonError("Access denied", 403);
    }
    if (fs.existsSync(target)) {
      return jsonError("Already exists", 409);
    }

    if (op === "mkdir") {
      fs.mkdirSync(target, { recursive: body.recursive === true });
      invalidateAllowedRootsCache();
      log.info("directory created", { path: target, durationMs: elapsedMs(startedAt) });
      return jsonOk({ path: target });
    }

    // op === "create" — empty file with optional initial content
    const content = typeof body.content === "string" ? body.content : "";
    fs.writeFileSync(target, content, "utf-8");
    invalidateAllowedRootsCache();
    log.info("file created", { path: target, size: content.length, durationMs: elapsedMs(startedAt) });
    return jsonOk({ path: target, size: content.length });
  } catch (error) {
    log.error("file mutation failed", { error, durationMs: elapsedMs(startedAt) });
    return jsonError(String(error), 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const startedAt = Date.now();
  try {
    const { path: segments } = await params;
    const targetPath = filePathFromSegments(segments);
    log.debug("file delete received", { path: targetPath });

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(targetPath, allowedRoots)) {
      log.warn("file delete denied", { path: targetPath, durationMs: elapsedMs(startedAt) });
      return jsonError("Access denied", 403);
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(targetPath);
    } catch {
      return jsonError("Not found", 404);
    }

    if (stat.isDirectory()) {
      const names = fs.readdirSync(targetPath);
      if (names.length > 0) {
        return jsonError("Directory not empty", 400);
      }
      fs.rmdirSync(targetPath);
    } else {
      fs.unlinkSync(targetPath);
    }

    invalidateAllowedRootsCache();
    log.info("file deleted", { path: targetPath, isDir: stat.isDirectory(), durationMs: elapsedMs(startedAt) });
    return jsonOk({ path: targetPath });
  } catch (error) {
    log.error("file delete failed", { error, durationMs: elapsedMs(startedAt) });
    return jsonError(String(error), 500);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const startedAt = Date.now();
  try {
    const { path: segments } = await params;
    const oldPath = filePathFromSegments(segments);
    const op = request.nextUrl.searchParams.get("type") ?? "rename";
    log.debug("file patch received", { op, path: oldPath });

    if (op !== "rename") {
      return jsonError("Invalid PATCH type", 400);
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(oldPath, allowedRoots)) {
      log.warn("file rename denied", { path: oldPath, durationMs: elapsedMs(startedAt) });
      return jsonError("Access denied", 403);
    }

    let body: { newName?: string };
    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid JSON body", 400);
    }
    if (typeof body.newName !== "string") {
      return jsonError("Missing 'newName' field", 400);
    }

    const v = validateFileName(body.newName);
    if (!v.ok) {
      return jsonError(v.message, 400);
    }
    const newName = v.name;

    if (IGNORED_NAMES.has(newName) || IGNORED_SUFFIXES.some((s) => newName.endsWith(s))) {
      return jsonError("Cannot rename to ignored name", 400);
    }

    if (!fs.existsSync(oldPath)) {
      return jsonError("Not found", 404);
    }

    const parentDir = path.dirname(oldPath);
    const newPath = path.join(parentDir, newName);
    if (!isPathAllowed(newPath, allowedRoots)) {
      return jsonError("Access denied", 403);
    }
    if (fs.existsSync(newPath)) {
      return jsonError("Already exists", 409);
    }

    // fs.renameSync throws on cross-device moves; we explicitly want same-dir only,
    // but the safety net is that `newPath` is computed from `path.dirname(oldPath)`.
    fs.renameSync(oldPath, newPath);
    invalidateAllowedRootsCache();
    log.info("file renamed", { from: oldPath, to: newPath, durationMs: elapsedMs(startedAt) });
    return jsonOk({ path: newPath, oldPath });
  } catch (error) {
    log.error("file rename failed", { error, durationMs: elapsedMs(startedAt) });
    return jsonError(String(error), 500);
  }
}
