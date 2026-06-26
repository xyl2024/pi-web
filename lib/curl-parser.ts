/**
 * Best-effort cURL command parser for the HTTP debug panel.
 *
 * Supports the flags that browser DevTools "Copy as cURL (bash)" emits,
 * plus a handful of common ones. Unsupported flags are collected into
 * `ParsedCurl.skipped` rather than rejected — users typically include
 * browser-irrelevant flags like `--compressed` or `-L` in the copied
 * string and we don't want a single such flag to fail the import.
 *
 * Pure function, no React. Returns a discriminated union so the call
 * site can render errors inline without throwing.
 */
import type { BodyMode, HttpMethod } from "@/hooks/httpStore";

export type { BodyMode, HttpMethod };

export interface ParsedCurlHeader {
  key: string;
  value: string;
}

export interface ParsedCurl {
  method: HttpMethod;
  /** URL preserved verbatim, including any query string. */
  url: string;
  headers: ParsedCurlHeader[];
  body: string;
  bodyMode: BodyMode;
  /** Unsupported flag names, surfaced as a toast after a successful import. */
  skipped: string[];
}

export type ParseCurlCode = "empty" | "no_url" | "invalid_syntax";

export type ParseCurlResult =
  | { ok: true; parsed: ParsedCurl }
  | { ok: false; code: ParseCurlCode; message: string };

const HTTP_METHODS: ReadonlySet<HttpMethod> = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
]);

function isHttpMethod(s: string): s is HttpMethod {
  return HTTP_METHODS.has(s as HttpMethod);
}

/** Unsupported flags that take no value. */
const UNSUPPORTED_NO_VALUE_FLAGS = new Set([
  "-L", "--location",
  "-k", "--insecure",
  "--compressed",
  "-G", "--get",
  "-s", "--silent", "-S", "--show-error",
  "-v", "--verbose",
  "-N", "--no-buffer",
  "-f", "--fail",
  "-i", "--include",
  "-I", "--head",
  "-#", "--progress-bar",
  "--http1.0", "--http1.1", "--http2", "--http2-prior-knowledge", "--http3",
  "--ssl", "--tcp-nodelay",
  "--no-keepalive", "--keepalive",
  "--no-progress-meter",
]);

/** Unsupported flags that consume the next token. */
const UNSUPPORTED_VALUE_FLAGS = new Set([
  "-F", "--form",
  "-o", "--output",
  "-D", "--dump-header",
  "-e", "--referer",
  "-m", "--max-time",
  "--connect-timeout",
  "-C", "--continue-at",
  "--retry", "--retry-delay", "--retry-max-time", "--retry-connrefused",
  "-T", "--upload-file",
  "-x", "--proxy",
  "--proxy-user", "--proxy-pass", "--proxy-header",
  "--interface",
  "--cacert", "--capath", "--cert", "--key", "--cert-type", "--key-type",
  "--resolve", "--resolve-list",
  "-w", "--write-out",
  "-r", "--range",
  "--limit-rate",
  "-Y", "--speed-limit", "-y", "--speed-time",
  "--max-filesize", "--max-redirs",
  "--abstract-unix-socket", "--unix-socket",
  "--alt-svc", "--hsts",
]);

/**
 * Tokenize a cURL command line, handling backslash line continuations,
 * single- and double-quoted strings, and backslash escapes outside quotes.
 *
 * The output is an array of already-decoded string tokens — the caller
 * does not need to interpret quoting further.
 */
function tokenize(input: string): string[] {
  // 1. Join backslash-newline continuations into a single space so
  //    "curl -X POST \\\n  'https://...'" tokenizes correctly.
  const normalized = input.replace(/\\\r?\n/g, " ");

  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i];

    if (inSingle) {
      // Inside single quotes: no escapes, raw chars until the next '.
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      i++;
      continue;
    }

    if (inDouble) {
      if (ch === "\\" && i + 1 < normalized.length) {
        const next = normalized[i + 1];
        if (next === '"' || next === "\\") {
          current += next;
          i += 2;
          continue;
        }
        // Unknown escape inside double quotes: keep both characters
        // (bash itself only interprets a small set; in cURL practice
        // the rest are passed through verbatim).
        current += ch + next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        i++;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    // Unquoted region.
    if (ch === "'") { inSingle = true; i++; continue; }
    if (ch === '"') { inDouble = true; i++; continue; }
    if (ch === "\\" && i + 1 < normalized.length) {
      // Backslash escapes the next char outside quotes.
      current += normalized[i + 1];
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
      continue;
    }
    current += ch;
    i++;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

function addHeader(
  headers: ParsedCurlHeader[],
  headerMap: Map<string, number>,
  key: string,
  value: string,
): void {
  const lower = key.toLowerCase();
  const existing = headerMap.get(lower);
  if (existing !== undefined) {
    // cURL semantics: later occurrences of the same header win.
    headers[existing] = { key, value };
  } else {
    headerMap.set(lower, headers.length);
    headers.push({ key, value });
  }
}

function deriveBodyMode(headers: ParsedCurlHeader[], hasBody: boolean): BodyMode {
  if (!hasBody) return "none";
  for (const h of headers) {
    if (h.key.toLowerCase() !== "content-type") continue;
    const ct = h.value.toLowerCase();
    // Match "application/json" with or without parameters
    // (e.g. "application/json; charset=utf-8").
    if (ct === "application/json" || ct.startsWith("application/json;") || ct.startsWith("application/json ")) {
      return "json";
    }
  }
  return "raw";
}

export function parseCurl(input: string): ParseCurlResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, code: "empty", message: "Import cURL command is empty." };
  }

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) {
    return { ok: false, code: "empty", message: "Import cURL command is empty." };
  }

  // Drop a leading "curl" verb if present (DevTools output starts with it).
  if (tokens[0] === "curl") tokens.shift();

  let method: HttpMethod | null = null;
  let url: string | null = null;
  const headers: ParsedCurlHeader[] = [];
  const headerMap = new Map<string, number>();
  const dataParts: string[] = [];
  const skipped: string[] = [];
  // -u / -b / -A are stored separately and applied as headers at the
  // end, so explicit -H 'Authorization:' / 'Cookie:' / 'User-Agent:'
  // that come after them still win (last-write semantics).
  const shortcuts: Array<{ kind: "auth" | "cookie" | "ua"; value: string }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];

    switch (tok) {
      case "-X":
      case "--request": {
        if (next === undefined) {
          return { ok: false, code: "invalid_syntax", message: `${tok} requires a value` };
        }
        const upper = next.toUpperCase();
        if (!isHttpMethod(upper)) {
          return { ok: false, code: "invalid_syntax", message: `Invalid HTTP method: ${next}` };
        }
        method = upper;
        i++;
        continue;
      }

      case "-H":
      case "--header": {
        if (next === undefined) {
          return { ok: false, code: "invalid_syntax", message: `${tok} requires a value` };
        }
        const colon = next.indexOf(":");
        if (colon === -1) {
          return { ok: false, code: "invalid_syntax", message: `Header must be "Key: Value", got: ${next}` };
        }
        const key = next.slice(0, colon).trim();
        const value = next.slice(colon + 1).trim();
        if (!key) {
          return { ok: false, code: "invalid_syntax", message: `Header name is empty in: ${next}` };
        }
        addHeader(headers, headerMap, key, value);
        i++;
        continue;
      }

      case "-d":
      case "--data": {
        if (next === undefined) {
          return { ok: false, code: "invalid_syntax", message: `${tok} requires a value` };
        }
        if (next.startsWith("@")) {
          // File reference — we can't read files in the browser, so skip
          // the body part and surface a warning.
          skipped.push(`${tok} (file ref @${next.slice(1)})`);
        } else {
          dataParts.push(next);
        }
        i++;
        continue;
      }

      case "--data-raw":
      case "--data-binary": {
        if (next === undefined) {
          return { ok: false, code: "invalid_syntax", message: `${tok} requires a value` };
        }
        // Unlike -d, --data-raw and --data-binary do NOT treat a leading
        // @ as a file ref — the @ is part of the literal body.
        dataParts.push(next);
        i++;
        continue;
      }

      case "--data-urlencode": {
        if (next === undefined) {
          return { ok: false, code: "invalid_syntax", message: `${tok} requires a value` };
        }
        const eq = next.indexOf("=");
        if (eq === -1) {
          // "curl --data-urlencode 'name'" encodes as "name=" (key only,
          // empty value). The whole token is the key.
          dataParts.push(`${encodeURIComponent(next)}=`);
        } else {
          const k = next.slice(0, eq);
          const v = next.slice(eq + 1);
          dataParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
        }
        i++;
        continue;
      }

      case "-u":
      case "--user": {
        if (next === undefined) {
          return { ok: false, code: "invalid_syntax", message: `${tok} requires a value` };
        }
        // btoa is available in the browser; "user:pass" may contain
        // non-ASCII (rare) — wrap in encodeURIComponent/decode to be
        // safe, matching what fetch will accept in an Authorization header.
        shortcuts.push({ kind: "auth", value: `Basic ${base64Encode(next)}` });
        i++;
        continue;
      }

      case "-b":
      case "--cookie": {
        if (next === undefined) {
          return { ok: false, code: "invalid_syntax", message: `${tok} requires a value` };
        }
        shortcuts.push({ kind: "cookie", value: next });
        i++;
        continue;
      }

      case "-A":
      case "--user-agent": {
        if (next === undefined) {
          return { ok: false, code: "invalid_syntax", message: `${tok} requires a value` };
        }
        shortcuts.push({ kind: "ua", value: next });
        i++;
        continue;
      }

      case "--json": {
        if (next === undefined) {
          return { ok: false, code: "invalid_syntax", message: `${tok} requires a value` };
        }
        // --json is shorthand for POST + Content-Type: application/json
        // + body. The method default below picks POST when a body is
        // present, so we only need to set the header and the body here.
        // An explicit -X later in the command will still win.
        addHeader(headers, headerMap, "Content-Type", "application/json");
        dataParts.push(next);
        i++;
        continue;
      }
    }

    if (UNSUPPORTED_NO_VALUE_FLAGS.has(tok)) {
      skipped.push(tok);
      continue;
    }

    if (UNSUPPORTED_VALUE_FLAGS.has(tok)) {
      skipped.push(tok);
      // Consume the value if it doesn't look like another flag. This is
      // a heuristic — cURL has a few flags whose values can start with
      // "-" (e.g. "--key -"), but in practice almost every copied cURL
      // from a browser uses a non-flag value here.
      if (next !== undefined && !next.startsWith("-")) i++;
      continue;
    }

    // Anything we haven't recognised that starts with '-' is treated as
    // an unknown flag — skip it (and its likely value) to avoid leaking
    // it into the URL or body.
    if (tok.startsWith("-") && tok.length > 1) {
      skipped.push(tok);
      if (next !== undefined && !next.startsWith("-")) i++;
      continue;
    }

    // Positional argument: the first one is the URL.
    if (url === null) {
      url = tok;
    } else {
      skipped.push(`extra positional: ${tok}`);
    }
  }

  // Apply shortcuts in command order, so a later explicit -H wins.
  for (const sc of shortcuts) {
    if (sc.kind === "auth") addHeader(headers, headerMap, "Authorization", sc.value);
    else if (sc.kind === "cookie") addHeader(headers, headerMap, "Cookie", sc.value);
    else addHeader(headers, headerMap, "User-Agent", sc.value);
  }

  // Default method: cURL picks GET when no body is supplied, POST when
  // there is. The user can still override by hand after import.
  if (method === null) {
    method = dataParts.length > 0 ? "POST" : "GET";
  }

  const body = dataParts.join("&");
  const bodyMode = deriveBodyMode(headers, body.length > 0);

  if (url === null) {
    return { ok: false, code: "no_url", message: "cURL command is missing a URL." };
  }

  return {
    ok: true,
    parsed: { method, url, headers, body, bodyMode, skipped },
  };
}

/**
 * Encode a string for use in an HTTP Basic auth header. btoa() only
 * handles Latin-1, so we first encode the string to UTF-8 bytes and
 * then re-package those bytes as a Latin-1 string (one char per byte)
 * that btoa can consume.
 */
function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
