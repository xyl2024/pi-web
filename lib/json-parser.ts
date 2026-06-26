// Tolerant first-value JSON parser.
//
// Standard JSON.parse requires the entire input to be one valid value.
// This module accepts extra leading/trailing content (e.g. a shell line
// with `prefix {"a":1} suffix`) by scanning the input for the first
// complete JSON value and parsing just that. Inner content must still
// be strict JSON — comments, trailing commas, and JSON5 are not
// supported (callers should clean their data first).

export type JsonParseResult =
  | { ok: true; value: unknown; ignoredPrefix: string; ignoredSuffix: string }
  | { ok: false; error: string };

/**
 * Parse `input` as JSON. Strict path: if the whole string is valid JSON,
 * return the value. Tolerant fallback: locate the first complete JSON
 * value within the string, parse it, and surface any surrounding junk
 * via `ignoredPrefix` / `ignoredSuffix` so callers can show a hint.
 */
export function parseJsonTolerant(input: string): JsonParseResult {
  if (input.length === 0) {
    return { ok: false, error: "empty input" };
  }

  try {
    const value = JSON.parse(input);
    return { ok: true, value, ignoredPrefix: "", ignoredSuffix: "" };
  } catch {
    // fall through to tolerant scan
  }

  const start = scanValueStart(input);
  if (start < 0) {
    return { ok: false, error: "no JSON value found" };
  }
  const end = scanValueEnd(input, start);
  if (end < 0) {
    return { ok: false, error: "incomplete JSON value" };
  }

  const ignoredPrefix = input.slice(0, start).trim();
  const ignoredSuffix = input.slice(end).trim();
  const candidate = input.slice(start, end);
  try {
    const value = JSON.parse(candidate);
    return { ok: true, value, ignoredPrefix, ignoredSuffix };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function scanValueStart(input: string): number {
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    if (c === "{" || c === "[" || c === '"' || c === "-" || c === "t" || c === "f" || c === "n" || (c >= "0" && c <= "9")) {
      return i;
    }
    return -1;
  }
  return -1;
}

/**
 * Given a position pointing at the start of a JSON value, return the
 * index just past the value's end. Returns -1 on incomplete input.
 */
function scanValueEnd(input: string, start: number): number {
  const c = input[start];
  if (c === "{") return scanBracketed(input, start, "{", "}");
  if (c === "[") return scanBracketed(input, start, "[", "]");
  if (c === '"') return scanString(input, start);
  if (c === "t") return input.startsWith("true", start) ? start + 4 : -1;
  if (c === "f") return input.startsWith("false", start) ? start + 5 : -1;
  if (c === "n") return input.startsWith("null", start) ? start + 4 : -1;
  if (c === "-" || (c >= "0" && c <= "9")) return scanNumber(input, start);
  return -1;
}

function scanBracketed(input: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < input.length; i++) {
    const c = input[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function scanString(input: string, start: number): number {
  let escape = false;
  for (let i = start + 1; i < input.length; i++) {
    const c = input[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') return i + 1;
  }
  return -1;
}

function scanNumber(input: string, start: number): number {
  let i = start;
  if (input[i] === "-") i++;
  if (i >= input.length) return -1;
  if (input[i] === "0") {
    i++;
  } else if (input[i] >= "1" && input[i] <= "9") {
    while (i < input.length && input[i] >= "0" && input[i] <= "9") i++;
  } else {
    return -1;
  }
  if (input[i] === ".") {
    i++;
    while (i < input.length && input[i] >= "0" && input[i] <= "9") i++;
  }
  if (input[i] === "e" || input[i] === "E") {
    i++;
    if (input[i] === "+" || input[i] === "-") i++;
    while (i < input.length && input[i] >= "0" && input[i] <= "9") i++;
  }
  return i;
}

/**
 * Minify a parsed JSON value: re-stringify with no whitespace.
 */
export function minifyJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Stringify a value as a JSON string literal's contents (i.e. escaped).
 * Example: `{"a":1}` → `{\"a\":1}`.
 */
export function escapeJsonString(value: unknown): string {
  return JSON.stringify(JSON.stringify(value)).slice(1, -1);
}
