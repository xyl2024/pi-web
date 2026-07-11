/**
 * Client-safe types + constants for the logger pipeline. Shared between the
 * server-side `lib/logger.ts` (which owns `fs`, file logging, the globalThis
 * ring buffer, and the SSE fan-out) and any client component that needs to
 * render log entries or interact with the ring capacity.
 *
 * Mirrors the `-types.ts` convention used elsewhere (see `show-file-tool-types.ts`
 * / `agent-todo-tool-types.ts`): the types are universal; the side-effecting
 * helpers stay server-only.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  seq: number;
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  /** Pre-serialized JSON of the structured `fields` argument, or undefined if
   *  none / serialization failed. Stored as a string so consumers can re-parse
   *  on demand without holding references to potentially cyclic objects. */
  fieldsJson?: string;
}

/** Upper bound on the in-memory ring buffer kept by `lib/logger.ts`. The UI
 *  caps its own entry list to the same value so the SSE snapshot and the
 *  client store never disagree. */
export const LOG_RING_CAPACITY = 2000;