/**
 * Per-session, on-disk JSONL persistence for the `agent_todo` tool.
 *
 * Layout: ~/.pi-web/agent-todo/<sessionId>.jsonl
 *   Each line is an `AgentTodoLogEntry` — one full snapshot per tool call.
 *
 * Conventions:
 * - The current state is *always* the last successfully parsed line's
 *   `stateAfter`. Reading the current state is therefore O(1) via tail-read.
 * - Writes are append-only; `appendAgentTodoEntry` calls fsync so SSE
 *   consumers always observe the line that's already on disk.
 * - Corrupt lines are tolerated: tail-read falls back to EMPTY_STATE and
 *   history reads skip malformed entries with a warning.
 * - File deletion happens on session DELETE; deletion is idempotent.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  EMPTY_STATE,
  type AgentTaskState,
  type AgentTodoLogEntry,
} from "./agent-todo-tool-types";
import { createLogger } from "./logger";

const log = createLogger("agent-todo-store");

const AGENT_TODO_DIR = path.join(os.homedir(), ".pi-web", "agent-todo");

/**
 * Read this many bytes from the end of the file when tail-reading. Bounded
 * so the operation stays O(1) regardless of file size; comfortably larger
 * than any realistic agent-todo line (a 50-task plan with activeForms
 * fits in well under 16KB).
 */
const TAIL_READ_BYTES = 256 * 1024;

function ensureDir(): void {
  if (!fs.existsSync(AGENT_TODO_DIR)) {
    fs.mkdirSync(AGENT_TODO_DIR, { recursive: true });
  }
}

export function agentTodoPath(sessionId: string): string {
  return path.join(AGENT_TODO_DIR, `${sessionId}.jsonl`);
}

/**
 * Read the last non-empty line of a file by tail-reading. The "last line"
 * is whatever bytes sit between the last two newlines (or, if the file
 * ends with newlines, we skip them and use the prior content).
 */
function readLastLine(filePath: string): string | null {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return null;

  const length = stat.size;
  const readSize = Math.min(length, TAIL_READ_BYTES);
  const start = length - readSize;

  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, start);

    // end = position just past the last non-newline byte (the line's
    // terminator). Skip trailing newlines so the file ending with `}\n\n\n`
    // still resolves to the `}` line.
    let end = buf.length;
    while (end > 0 && buf[end - 1] === 0x0a) end--;
    if (end === 0) return null;

    // start = position right after the previous newline.
    let startInBuf = 0;
    for (let i = end - 1; i >= 0; i--) {
      if (buf[i] === 0x0a) { startInBuf = i + 1; break; }
    }
    return buf.subarray(startInBuf, end).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read the current task state for a session. O(1) — tail-reads the last
 * JSONL line. A non-existent or unreadable file yields EMPTY_STATE; a
 * malformed tail line is treated as empty (a warning is logged).
 */
export function readAgentTodoState(sessionId: string): AgentTaskState {
  const filePath = agentTodoPath(sessionId);
  if (!fs.existsSync(filePath)) return EMPTY_STATE;

  try {
    const last = readLastLine(filePath);
    if (!last) return EMPTY_STATE;
    const entry = JSON.parse(last) as AgentTodoLogEntry;
    return entry.stateAfter ?? EMPTY_STATE;
  } catch (error) {
    log.warn("agent-todo tail read failed", { sessionId, error });
    return EMPTY_STATE;
  }
}

/**
 * Read the full action history. O(n) — used by the (future) history viewer,
 * not by the live panel.
 */
export function readAgentTodoHistory(sessionId: string): AgentTodoLogEntry[] {
  const filePath = agentTodoPath(sessionId);
  if (!fs.existsSync(filePath)) return [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    log.warn("agent-todo history read failed", { sessionId, error });
    return [];
  }
  const out: AgentTodoLogEntry[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw) as AgentTodoLogEntry);
    } catch (error) {
      log.warn("agent-todo history line skipped", { sessionId, error });
    }
  }
  return out;
}

/**
 * Append one audit record and fsync before returning. Order: ensure dir →
 * open fd → write → fsync → close. A single fd is used for write + fsync
 * so the kernel sees them as one transaction.
 */
export function appendAgentTodoEntry(
  sessionId: string,
  entry: AgentTodoLogEntry,
): void {
  ensureDir();
  const filePath = agentTodoPath(sessionId);
  const fd = fs.openSync(filePath, "a");
  try {
    const line = JSON.stringify(entry) + "\n";
    fs.writeSync(fd, line, null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Copy a session's agent-todo file to a new session id (fork). If the
 * source has no file, this is a no-op — the child will start empty.
 */
export function copyAgentTodoFile(fromSessionId: string, toSessionId: string): void {
  const src = agentTodoPath(fromSessionId);
  if (!fs.existsSync(src)) return;
  ensureDir();
  const dst = agentTodoPath(toSessionId);
  fs.copyFileSync(src, dst);
}

/** Delete a session's agent-todo file. Idempotent. */
export function deleteAgentTodoFile(sessionId: string): void {
  const filePath = agentTodoPath(sessionId);
  if (!fs.existsSync(filePath)) return;
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    log.warn("agent-todo unlink failed", { sessionId, error });
  }
}