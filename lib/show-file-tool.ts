/**
 * Custom Pi Agent tool: `show_file`.
 *
 * Displays one or more files inline below the tool call in the chat UI.
 * Supports images, video, audio, PDFs, HTML (sandbox iframe), and text.
 *
 * Validation reuses lib/file-access.ts so the path is restricted to the
 * same allowed roots the `/api/files` route enforces (sessions' cwds +
 * `~/.pi-web/workspace/pi-cwd-*`).
 *
 * IMPORTANT: This file imports `@earendil-works/pi-coding-agent`, which
 * transitively pulls in server-only Node modules. Client code that needs
 * the tool name or types must import from `./show-file-tool-types` instead.
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { getAllowedRoots, isPathAllowed } from "./file-access";
import {
  SHOW_FILE_TOOL_NAME,
  SHOW_FILE_MAX_PATHS,
  categorizeByExt,
  type ShowFileDetails,
  type ShowFileEntry,
} from "./show-file-tool-types";

export { SHOW_FILE_TOOL_NAME, SHOW_FILE_MAX_PATHS, categorizeByExt };
export type { ShowFileCategory, ShowFileDetails, ShowFileEntry } from "./show-file-tool-types";

const ShowFileParams = Type.Object({
  paths: Type.Array(
    Type.String({
      description:
        "Absolute path to the file to display. Relative paths are resolved against the session's working directory. Supports images (png/jpg/gif/webp/svg/...), video (mp4/webm/mov/...), audio (mp3/wav/...), PDFs, HTML files (rendered in a sandboxed iframe), and text/markdown files.",
    }),
    {
      minItems: 1,
      maxItems: SHOW_FILE_MAX_PATHS,
      description: `1 to ${SHOW_FILE_MAX_PATHS} files to display together in a single tool call.`,
    },
  ),
});

function result<T>(text: string, details: T) {
  return { content: [{ type: "text" as const, text }], details };
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function resolvePath(input: string, cwd: string): string {
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(cwd, input);
}

function processOne(absPath: string): ShowFileEntry {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    return {
      path: absPath,
      exists: false,
      error: `File not found: ${absPath} (${e instanceof Error ? e.message : String(e)})`,
    };
  }

  if (!stat.isFile()) {
    return {
      path: absPath,
      exists: false,
      error: `Not a regular file: ${absPath}`,
    };
  }

  const category = categorizeByExt(absPath);
  const size = stat.size;
  return {
    path: absPath,
    exists: true,
    category,
    size,
    summary: `Displayed ${absPath} (${category}, ${fmtSize(size)})`,
  };
}

export const showFileTool = defineTool<typeof ShowFileParams, ShowFileDetails>({
  name: SHOW_FILE_TOOL_NAME,
  label: "Show File",
  description:
    "Display up to 5 files inline in the chat (supported file types: images, video, audio, PDFs, HTML, text/markdown).",
  parameters: ShowFileParams,
  executionMode: "sequential",
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const rawPaths = params.paths;

    if (rawPaths.length === 0) {
      return result<ShowFileDetails>(
        "Error: At least one path is required.",
        {
          files: [],
          summary: "No paths provided.",
        },
      );
    }

    if (rawPaths.length > SHOW_FILE_MAX_PATHS) {
      return result<ShowFileDetails>(
        `Error: Too many paths (${rawPaths.length}); maximum is ${SHOW_FILE_MAX_PATHS}.`,
        {
          files: [],
          summary: `Too many paths (${rawPaths.length} > ${SHOW_FILE_MAX_PATHS}).`,
        },
      );
    }

    let allowedRoots: Set<string>;
    try {
      allowedRoots = await getAllowedRoots();
    } catch (e) {
      const message = `Failed to check allowed roots: ${e instanceof Error ? e.message : String(e)}`;
      return result<ShowFileDetails>(
        `Error: ${message}`,
        {
          files: rawPaths.map((p) => ({
            path: typeof p === "string" ? resolvePath(p, ctx.cwd) : "",
            exists: false,
            error: message,
          })),
          summary: message,
        },
      );
    }

    const files: ShowFileEntry[] = rawPaths.map((p) => {
      if (typeof p !== "string" || p.length === 0) {
        return {
          path: "",
          exists: false,
          error: "Path must be a non-empty string.",
        };
      }
      const abs = resolvePath(p, ctx.cwd);
      if (!isPathAllowed(abs, allowedRoots)) {
        return {
          path: abs,
          exists: false,
          error: `Path not in allowed roots: ${abs}`,
        };
      }
      return processOne(abs);
    });

    const okCount = files.filter((f) => f.exists).length;
    const failCount = files.length - okCount;
    const summary =
      failCount === 0
        ? `Displayed ${okCount} file${okCount === 1 ? "" : "s"}.`
        : `Displayed ${okCount} of ${files.length} files; ${failCount} failed.`;

    return result<ShowFileDetails>(summary, { files, summary });
  },
});

export function buildShowFileTool() {
  return [showFileTool];
}
