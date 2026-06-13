/**
 * Client-safe constants, types, and pure helpers for the `show_file` tool.
 *
 * This file MUST NOT import `@earendil-works/pi-coding-agent` or any
 * server-only Node module — it's imported by client components
 * (`components/MessageView.tsx`) to match the tool name without pulling
 * the SDK's `child_process` dependency into the browser bundle.
 */

export const SHOW_FILE_TOOL_NAME = "show_file";

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "ogg", "ogv", "m4v"]);
const AUDIO_EXTS = new Set([
  "mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba", "webm",
]);
const PDF_EXTS = new Set(["pdf"]);
const HTML_EXTS = new Set(["html", "htm"]);
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "xml", "yaml", "yml",
  "csv", "tsv", "log", "ini", "conf", "sh", "bash", "zsh", "fish",
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "cpp", "cc", "h", "hpp", "cs",
  "css", "scss", "less", "vue", "svelte",
  "sql", "graphql", "gql", "toml", "env", "gitignore",
]);

export type ShowFileCategory =
  | "image" | "video" | "audio" | "pdf" | "html" | "text" | "binary";

export interface ShowFileDetails {
  /** Absolute path that was resolved and validated. */
  path: string;
  /** Whether the file existed and was readable at execution time. */
  exists: boolean;
  /** Coarse rendering category used by the frontend to pick a viewer. */
  category?: ShowFileCategory;
  /** File size in bytes, when known. */
  size?: number;
  /** Human-readable one-liner returned to the model. */
  summary?: string;
  /** Error message when `exists` is false or access was denied. */
  error?: string;
}

export function categorizeByExt(filePath: string): ShowFileCategory {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (PDF_EXTS.has(ext)) return "pdf";
  if (HTML_EXTS.has(ext)) return "html";
  if (TEXT_EXTS.has(ext)) return "text";
  return "binary";
}