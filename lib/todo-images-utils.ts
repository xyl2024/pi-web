// Shared helpers for todo image filenames. Kept React-free so both the
// client-side editor and the server-side export route can use them.

// Strict whitelist: UUID v4 hex + limited image extensions. Mirrors the
// regex in app/api/todo-images/[filename]/route.ts; both must accept the
// same set or the serve route would 400 on a name the export route happily
// included.
export const TODO_IMAGE_FILENAME_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif)$/i;

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
