/**
 * Custom Pi Agent tool: `show_file`.
 *
 * Displays a file inline below the tool call in the chat UI.
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
  categorizeByExt,
  type ShowFileDetails,
} from "./show-file-tool-types";

export { SHOW_FILE_TOOL_NAME, categorizeByExt };
export type { ShowFileCategory, ShowFileDetails } from "./show-file-tool-types";

const ShowFileParams = Type.Object({
  path: Type.String({
    description:
      "Absolute path to the file to display. Relative paths are resolved against the session's working directory. Supports images (png/jpg/gif/webp/svg/...), video (mp4/webm/mov/...), audio (mp3/wav/...), PDFs, HTML files (rendered in a sandboxed iframe), and text/markdown files.",
  }),
  description: Type.Optional(
    Type.String({
      description: "Optional caption shown above the rendered content. The model sees this in the tool result; the frontend may render it as a header in future updates.",
    }),
  ),
});

function result<T>(text: string, details: T) {
  return { content: [{ type: "text" as const, text }], details };
}

function errResult<T>(message: string, details: T) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details,
  };
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const showFileTool = defineTool<typeof ShowFileParams, ShowFileDetails>({
  name: SHOW_FILE_TOOL_NAME,
  label: "Show File",
  description:
    "Display a file in the chat UI below the tool call. Renders images inline, plays video/audio with native controls, shows PDFs, displays HTML in a sandboxed iframe (scripts allowed, same-origin denied), renders Excalidraw scenes read-only, and renders text/markdown as a code block. Use this whenever the user should see the actual file content rather than just hear about it. The file must be inside the session's working directory or another allowed root.",
  parameters: ShowFileParams,
  executionMode: "sequential",
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const absPath = path.isAbsolute(params.path)
      ? path.normalize(params.path)
      : path.resolve(ctx.cwd, params.path);

    try {
      const allowedRoots = await getAllowedRoots();
      if (!isPathAllowed(absPath, allowedRoots)) {
        const message = `Path not in allowed roots: ${absPath}`;
        return errResult<ShowFileDetails>(message, {
          path: absPath,
          exists: false,
          error: message,
        });
      }
    } catch (e) {
      const message = `Failed to check allowed roots: ${e instanceof Error ? e.message : String(e)}`;
      return errResult<ShowFileDetails>(message, {
        path: absPath,
        exists: false,
        error: message,
      });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch (e) {
      const message = `File not found: ${absPath} (${e instanceof Error ? e.message : String(e)})`;
      return errResult<ShowFileDetails>(message, {
        path: absPath,
        exists: false,
        error: message,
      });
    }

    if (!stat.isFile()) {
      const message = `Not a regular file: ${absPath}`;
      return errResult<ShowFileDetails>(message, {
        path: absPath,
        exists: false,
        error: message,
      });
    }

    const category = categorizeByExt(absPath);
    const size = stat.size;
    const summary = `Displayed ${absPath} (${category}, ${fmtSize(size)})`;
    return result<ShowFileDetails>(summary, {
      path: absPath,
      exists: true,
      category,
      size,
      summary,
    });
  },
});

export function buildShowFileTool() {
  return [showFileTool];
}