/**
 * Resolve the public origin used to absolutize todo image URLs in the
 * `user_todo_description` agent tool.
 *
 * The tool's `execute()` runs server-side inside the AgentSessionWrapper
 * without a `Request` object, so it cannot call `new URL(req.url).origin`.
 * Instead it walks a small env-var cascade (highest priority first) and
 * falls back to a localhost default that matches the dev port documented in
 * the project root.
 *
 * Override order:
 *   1. `PI_WEB_PUBLIC_BASE_URL` — explicit public origin (recommended when
 *      running behind a reverse proxy / ngrok / tunnel).
 *   2. `NEXTAUTH_URL` — NextAuth convention, often already set to the public
 *      origin in production.
 *   3. `BASE_URL` — generic fallback.
 *   4. `http://localhost:${process.env.PORT ?? "30141"}` — matches the dev
 *      port (`npm run dev`) and the documented production startup port
 *      `PI_PORT=14514` set via `PORT` in the systemd unit.
 *   5. `http://localhost` — last resort when nothing else is configured.
 *
 * Each candidate is validated with `new URL(...)`; malformed values fall
 * through to the next candidate so a stray typo doesn't crash tool calls.
 *
 * The result is computed once at module init and cached, so per-call
 * overhead is negligible. Server-side env is expected to be stable for the
 * lifetime of the process; if the operator needs to change the public
 * origin, they restart the server (which is also when they typically
 * restart the AgentSession registry).
 */

const DEFAULT_DEV_PORT = "30141";

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function tryParse(value: string): string | undefined {
  try {
    const url = new URL(value);
    // `origin` is `${protocol}://${host}` — exactly what we want for
    // absolutizing paths like `/api/todo-images/<name>`.
    return stripTrailingSlash(url.origin);
  } catch {
    return undefined;
  }
}

function pickBaseUrl(): string {
  const candidates: Array<string | undefined> = [
    process.env.PI_WEB_PUBLIC_BASE_URL?.trim(),
    process.env.NEXTAUTH_URL?.trim(),
    process.env.BASE_URL?.trim(),
    `http://localhost:${process.env.PORT ?? DEFAULT_DEV_PORT}`,
    "http://localhost",
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const parsed = tryParse(raw);
    if (parsed) return parsed;
  }
  // Unreachable: the literal `"http://localhost"` always parses, but keep a
  // safety net so the function is total.
  return "http://localhost";
}

let cached: string | null = null;

/**
 * Return the cached public origin used to absolutize todo image URLs.
 */
export function getTodoImageBaseUrl(): string {
  if (cached === null) cached = pickBaseUrl();
  return cached;
}

/**
 * Reset the cached base URL. Test-only — production code does not need to
 * invalidate the cache because env is read once at process start.
 */
export function __resetTodoImageBaseUrlForTests(): void {
  cached = null;
}

/**
 * Build an absolute URL for a todo image by `filename`. The filename is
 * assumed to already pass `TODO_IMAGE_FILENAME_RE` (defense-in-depth at the
 * serve route) — we do not re-validate here to keep the tool call cheap.
 */
export function todoImageUrl(filename: string): string {
  return `${getTodoImageBaseUrl()}/api/todo-images/${filename}`;
}