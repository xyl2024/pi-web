/**
 * Per-session, on-disk capture of provider request/response payloads.
 *
 * Layout: ~/.pi-web/payloads/<sessionId>.jsonl
 *   Each line is either:
 *     { kind: "request",  index, timestamp, payload }
 *     { kind: "response", index, timestamp, status, headers }
 *   Index is monotonic per session (assigned at request time).
 *
 * Captured via inline pi extension hooks (before_provider_request /
 * after_provider_response). Survives session unload and process restart.
 * Deleted only when the session itself is deleted (DELETE /api/sessions/[id]).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./logger";

const log = createLogger("payload-capture");

const PAYLOAD_DIR = join(homedir(), ".pi-web", "payloads");

export interface CapturedPayload {
  index: number;
  timestamp: number;
  payload: unknown;
  response?: {
    status: number;
    headers: Record<string, string>;
    timestamp: number;
  };
}

interface RequestLine {
  kind: "request";
  index: number;
  timestamp: number;
  payload: unknown;
}

interface ResponseLine {
  kind: "response";
  index: number;
  timestamp: number;
  status: number;
  headers: Record<string, string>;
}

type Line = RequestLine | ResponseLine;

/**
 * Per-session monotonic counter, kept in memory.
 * Seeded from the existing file on first use so restarts continue numbering
 * from where they left off (no collisions on `index`).
 */
const nextIndex = new Map<string, number>();

function ensureDir(): void {
  if (!existsSync(PAYLOAD_DIR)) {
    mkdirSync(PAYLOAD_DIR, { recursive: true });
  }
}

function fileFor(sessionId: string): string {
  return join(PAYLOAD_DIR, `${sessionId}.jsonl`);
}

function readLines(sessionId: string): Line[] {
  const path = fileFor(sessionId);
  if (!existsSync(path)) return [];
  const out: Line[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw) as Line);
    } catch {
      // Skip a torn trailing line; safer than dropping the whole history.
    }
  }
  return out;
}

function seedIndex(sessionId: string): number {
  const lines = readLines(sessionId);
  let max = -1;
  for (const l of lines) {
    if (l.kind === "request" && l.index > max) max = l.index;
  }
  return max + 1;
}

function allocateIndex(sessionId: string): number {
  let next = nextIndex.get(sessionId);
  if (next === undefined) {
    next = seedIndex(sessionId);
  }
  nextIndex.set(sessionId, next + 1);
  return next;
}

function append(sessionId: string, line: Line): void {
  try {
    ensureDir();
    appendFileSync(fileFor(sessionId), JSON.stringify(line) + "\n", "utf8");
  } catch (error) {
    log.warn("payload append failed", { sessionId, error });
  }
}

/** Record an outgoing provider request payload. Returns the assigned index. */
export function recordRequest(sessionId: string, payload: unknown): number {
  const index = allocateIndex(sessionId);
  append(sessionId, { kind: "request", index, timestamp: Date.now(), payload });
  return index;
}

/**
 * Attach response details to the most recent request that doesn't yet have one.
 * Pi serializes provider exchanges per-turn, so the latest pending request is
 * always the correct match.
 */
export function recordResponse(
  sessionId: string,
  status: number,
  headers: Record<string, string>,
): void {
  const lines = readLines(sessionId);
  const seen = new Set<number>();
  for (const l of lines) {
    if (l.kind === "response") seen.add(l.index);
  }
  let pendingIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.kind === "request" && !seen.has(l.index)) {
      pendingIndex = l.index;
      break;
    }
  }
  if (pendingIndex < 0) {
    log.warn("response received with no pending request", { sessionId, status });
    return;
  }
  append(sessionId, {
    kind: "response",
    index: pendingIndex,
    timestamp: Date.now(),
    status,
    headers,
  });
}

/** Read-only snapshot, paired by index. */
export function listPayloads(sessionId: string): CapturedPayload[] {
  const lines = readLines(sessionId);
  const requests = new Map<number, RequestLine>();
  const responses = new Map<number, ResponseLine>();
  for (const l of lines) {
    if (l.kind === "request") requests.set(l.index, l);
    else responses.set(l.index, l);
  }
  return [...requests.values()]
    .sort((a, b) => a.index - b.index)
    .map((req) => {
      const resp = responses.get(req.index);
      return {
        index: req.index,
        timestamp: req.timestamp,
        payload: req.payload,
        response: resp
          ? { status: resp.status, headers: resp.headers, timestamp: resp.timestamp }
          : undefined,
      };
    });
}

export function getPayload(sessionId: string, index: number): CapturedPayload | undefined {
  return listPayloads(sessionId).find((e) => e.index === index);
}

/** Delete a session's capture file. Called when the session itself is deleted. */
export function deleteFor(sessionId: string): void {
  const path = fileFor(sessionId);
  nextIndex.delete(sessionId);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch (error) {
    log.warn("payload file unlink failed", { sessionId, error });
  }
}
