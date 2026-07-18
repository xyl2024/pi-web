// Shared helpers for todo image filenames. Kept React-free so both the
// client-side editor and the server-side export route, plus the upload and
// serve API routes, can use them.

// Strict whitelist: UUID v4 hex + limited image extensions. Mirrors the
// regex in app/api/todo-images/[filename]/route.ts; both must accept the
// same set or the serve route would 400 on a name the export route happily
// included.
export const TODO_IMAGE_FILENAME_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif)$/i;

// Mime ↔ extension maps shared by the upload route (mime → ext when naming a
// freshly-uploaded file) and the serve route (ext → mime when responding).
// Centralizing them here means a new image format only needs to be added in
// one place; both routes already accepted the same 8 entries before this
// consolidation.
export const TODO_IMAGE_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/avif": "avif",
};

export const TODO_IMAGE_EXT_TO_MIME: Record<string, string> = {
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

/**
 * Look up the mime type for a todo image by its filename. Falls back to
 * `application/octet-stream` so the serve route keeps its current
 * behavior for unknown extensions (rather than crashing or 500ing).
 */
export function mimeForTodoImageFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  return TODO_IMAGE_EXT_TO_MIME[ext] ?? "application/octet-stream";
}

// Extract every /api/todo-images/<filename> reference from a markdown
// description, in document order, deduplicated. Only filenames passing
// TODO_IMAGE_FILENAME_RE are returned (defense-in-depth against any stray
// path-separator-bearing reference in user input).
export function extractTodoImageFilenames(description: string): string[] {
  const re = /!\[[^\]]*\]\(\/api\/todo-images\/([^)\s]+?)(?:\s+"[^"]*")?\)/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(description)) !== null) {
    const filename = m[1];
    if (!TODO_IMAGE_FILENAME_RE.test(filename)) continue;
    if (seen.has(filename)) continue;
    seen.add(filename);
    out.push(filename);
  }
  return out;
}
