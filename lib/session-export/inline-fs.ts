// Server-side "inline a file from disk into the export HTML as base64" helper.
//
// Used by app/api/sessions/[id]/export to materialise show_file referenced
// paths into self-contained `data:` URLs. Reuses the same `getAllowedRoots`
// allowlist as the in-conversation show_file tool so the export never expands
// the permissions boundary beyond what the user could already read in pi-web.
//
// 5 MB threshold (5 * 1024 * 1024 bytes) — anything larger becomes a "skipped"
// placeholder so the rendered HTML stays portable (under most SMTP gateways).

import { existsSync, readFileSync, statSync } from "fs";

import { ensurePathAllowed, isPathAllowed, getAllowedRoots } from "@/lib/file-access";

export const INLINE_THRESHOLD_BYTES = 5 * 1024 * 1024;

export type AttachmentInline = {
  kind: "inline";
  mime: string;
  base64: string;
  size: number;
};

export type AttachmentSkipped = {
  kind: "skipped";
  reason: "too-large" | "not-allowed" | "missing";
  size?: number;
};

export type AttachmentResult = AttachmentInline | AttachmentSkipped;

// Hardcoded extension → MIME map. Avoids the runtime `mime-types` package and
// is plenty for the file types show_file emits (text, source, image, audio,
// video, pdf, common archive). Anything not in the map falls through to
// `application/octet-stream`.
const EXT_TO_MIME: Record<string, string> = {
  // text
  txt: "text/plain",
  md: "text/markdown",
  log: "text/plain",
  csv: "text/csv",
  // data
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  // code (treated as text/plain — the .markdown-body CSS won't style them,
  // but `<pre>` will preserve layout)
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  py: "text/plain",
  rs: "text/plain",
  go: "text/plain",
  java: "text/plain",
  rb: "text/plain",
  php: "text/plain",
  sh: "text/plain",
  bash: "text/plain",
  css: "text/css",
  html: "text/html",
  htm: "text/html",
  // images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  // video
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  // audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  // docs / archives
  pdf: "application/pdf",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
};

export function mimeFromPath(absPath: string): string {
  const dot = absPath.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = absPath.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

export function baseName(absPath: string): string {
  const parts = absPath.split(/[\\/]/);
  return parts[parts.length - 1] || absPath;
}

export async function inlineFileByPath(absPath: string): Promise<AttachmentResult> {
  // 1. existence check
  if (!existsSync(absPath)) {
    return { kind: "skipped", reason: "missing" };
  }
  // 2. allowlist check (same roots show_file uses)
  const allowed = await ensurePathAllowed(absPath);
  if (!allowed) {
    // Fall back: file-access.ts's getAllowedRoots is session-derived, but the
    // export may legitimately reference files outside any active session cwd
    // (the agent could have navigated to a sibling dir mid-session). To stay
    // safe we ship "skipped" rather than expand the allowlist.
    return { kind: "skipped", reason: "not-allowed" };
  }

  // 3. size check
  let size: number;
  try {
    size = statSync(absPath).size;
  } catch {
    return { kind: "skipped", reason: "missing" };
  }
  if (size > INLINE_THRESHOLD_BYTES) {
    return { kind: "skipped", reason: "too-large", size };
  }
  // 4. read + base64
  try {
    const buf = readFileSync(absPath);
    return {
      kind: "inline",
      mime: mimeFromPath(absPath),
      base64: buf.toString("base64"),
      size,
    };
  } catch {
    return { kind: "skipped", reason: "missing" };
  }
}

// Re-export so the renderer / route layer doesn't have to reach into
// lib/file-access.ts directly.
export { getAllowedRoots, isPathAllowed };
