/**
 * CRUD on top of the scheduler DB.
 *
 * Mirrors lib/todo-store.ts: validation helpers + typed error class +
 * pure CRUD functions. All validation happens before any DB write so the
 * route layer can blindly trust input shape.
 *
 * `next_run_at` is computed via croner whenever a task is loaded or its
 * cron/cwd/enabled state changes. Storing it lets the scheduling loop
 * find the soonest trigger with a single index scan.
 */

import { Cron } from "croner";
import { existsSync } from "fs";
import { getSchedulerDb } from "./scheduler-db";
import { createLogger } from "./logger";

const log = createLogger("scheduler-store");

const MAX_NAME_LENGTH = 200;
const MAX_PROMPT_LENGTH = 50_000;
const MAX_CRON_LENGTH = 100;
const DEFAULT_RUNS_LIMIT = 50;

export type TaskRunStatus = "running" | "success" | "error" | "timeout";

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  cwd: string;
  prompt: string;
  enabled: boolean;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  toolNames: string[] | null;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastRunStatus: TaskRunStatus | null;
}

export interface TaskRun {
  id: string;
  taskId: string;
  startedAt: number;
  endedAt: number | null;
  status: TaskRunStatus;
  replyText: string | null;
  error: string | null;
  sessionId: string | null;
  durationMs: number | null;
}

export interface CreateTaskInput {
  name: string;
  cron: string;
  cwd: string;
  prompt: string;
  enabled?: boolean;
  provider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
  toolNames?: string[] | null;
}

export interface UpdateTaskInput {
  id: string;
  name?: string;
  cron?: string;
  cwd?: string;
  prompt?: string;
  enabled?: boolean;
  provider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
  toolNames?: string[] | null;
}

export interface RecordRunEndInput {
  status: TaskRunStatus;
  replyText?: string | null;
  error?: string | null;
  sessionId?: string | null;
  durationMs?: number;
}

export class SchedulerValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "SchedulerValidationError";
    this.field = field;
  }
}

export class SchedulerNotFoundError extends Error {
  constructor(id: string) {
    super(`Scheduled task not found: ${id}`);
    this.name = "SchedulerNotFoundError";
  }
}

function validateName(raw: unknown): string {
  if (typeof raw !== "string") throw new SchedulerValidationError("name", "name must be a string");
  const v = raw.trim();
  if (!v) throw new SchedulerValidationError("name", "name is required");
  if (v.length > MAX_NAME_LENGTH) throw new SchedulerValidationError("name", `name must be ≤ ${MAX_NAME_LENGTH} chars`);
  return v;
}

function validateCron(raw: unknown): string {
  if (typeof raw !== "string") throw new SchedulerValidationError("cron", "cron must be a string");
  const v = raw.trim();
  if (!v) throw new SchedulerValidationError("cron", "cron is required");
  if (v.length > MAX_CRON_LENGTH) throw new SchedulerValidationError("cron", `cron must be ≤ ${MAX_CRON_LENGTH} chars`);
  try {
    new Cron(v);
  } catch (err) {
    throw new SchedulerValidationError("cron", `invalid cron expression: ${err instanceof Error ? err.message : String(err)}`);
  }
  return v;
}

function validateCwd(raw: unknown): string {
  if (typeof raw !== "string") throw new SchedulerValidationError("cwd", "cwd must be a string");
  const v = raw.trim();
  if (!v) throw new SchedulerValidationError("cwd", "cwd is required");
  if (!existsSync(v)) throw new SchedulerValidationError("cwd", `cwd does not exist: ${v}`);
  return v;
}

function validatePrompt(raw: unknown): string {
  if (typeof raw !== "string") throw new SchedulerValidationError("prompt", "prompt must be a string");
  const v = raw.trim();
  if (!v) throw new SchedulerValidationError("prompt", "prompt is required");
  if (v.length > MAX_PROMPT_LENGTH) throw new SchedulerValidationError("prompt", `prompt must be ≤ ${MAX_PROMPT_LENGTH} chars`);
  return v;
}

function validateOptionalString(field: string, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") throw new SchedulerValidationError(field, `${field} must be a string`);
  return raw.trim() || null;
}

function validateToolNames(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    if (!raw.every((t) => typeof t === "string")) {
      throw new SchedulerValidationError("toolNames", "toolNames must be an array of strings");
    }
    return raw as string[];
  }
  throw new SchedulerValidationError("toolNames", "toolNames must be an array or null");
}

/** Compute next_run_at for an enabled task; null if disabled or cron invalid. */
function computeNextRun(cron: string, enabled: boolean): number | null {
  if (!enabled) return null;
  try {
    const next = new Cron(cron).nextRun();
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

interface Row {
  id: string;
  name: string;
  cron: string;
  cwd: string;
  prompt: string;
  enabled: number;
  provider: string | null;
  model_id: string | null;
  thinking_level: string | null;
  tool_names: string | null;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
  last_run_status: TaskRunStatus | null;
}

function parseToolNames(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rowToTask(row: Row): ScheduledTask {
  // If next_run_at is stale (e.g. process was down across a trigger time),
  // recompute it. Cheap Cron.nextRun() — runs only on list, not on every read.
  const enabled = row.enabled === 1;
  let nextRunAt = row.next_run_at;
  if (enabled && nextRunAt !== null && nextRunAt < Date.now()) {
    nextRunAt = computeNextRun(row.cron, true);
  }
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    cwd: row.cwd,
    prompt: row.prompt,
    enabled,
    provider: row.provider,
    modelId: row.model_id,
    thinkingLevel: row.thinking_level,
    toolNames: parseToolNames(row.tool_names),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    nextRunAt,
    lastRunStatus: row.last_run_status,
  };
}

const TASK_WITH_LAST_RUN_QUERY = `
  SELECT t.*, (
    SELECT status FROM task_runs r
    WHERE r.task_id = t.id
    ORDER BY r.started_at DESC LIMIT 1
  ) AS last_run_status
  FROM scheduled_tasks t
`;

export function listTasks(): ScheduledTask[] {
  const db = getSchedulerDb();
  const rows = db.prepare(`${TASK_WITH_LAST_RUN_QUERY} ORDER BY t.created_at DESC`).all() as Row[];
  return rows.map(rowToTask);
}

export function getTask(id: string): ScheduledTask | null {
  const db = getSchedulerDb();
  const row = db.prepare(`${TASK_WITH_LAST_RUN_QUERY} WHERE t.id = ?`).get(id) as Row | undefined;
  return row ? rowToTask(row) : null;
}

export function createTask(input: CreateTaskInput): ScheduledTask {
  const name = validateName(input.name);
  const cron = validateCron(input.cron);
  const cwd = validateCwd(input.cwd);
  const prompt = validatePrompt(input.prompt);
  const enabled = input.enabled === undefined ? true : !!input.enabled;
  const provider = validateOptionalString("provider", input.provider);
  const modelId = validateOptionalString("modelId", input.modelId);
  const thinkingLevel = validateOptionalString("thinkingLevel", input.thinkingLevel);
  const toolNames = validateToolNames(input.toolNames);
  const now = Date.now();
  const id = newId();
  const nextRunAt = computeNextRun(cron, enabled);

  getSchedulerDb()
    .prepare(
      `INSERT INTO scheduled_tasks
        (id, name, cron, cwd, prompt, enabled, provider, model_id, thinking_level, tool_names,
         created_at, updated_at, last_run_at, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    )
    .run(
      id, name, cron, cwd, prompt, enabled ? 1 : 0,
      provider, modelId, thinkingLevel,
      toolNames ? JSON.stringify(toolNames) : null,
      now, now, nextRunAt,
    );

  log.info("task created", { id, name, cron, cwd });
  return getTask(id)!;
}

export function updateTask(input: UpdateTaskInput): ScheduledTask {
  const existing = getTask(input.id);
  if (!existing) throw new SchedulerNotFoundError(input.id);

  const patch: Partial<ScheduledTask> = {};
  if (input.name !== undefined) patch.name = validateName(input.name);
  if (input.cron !== undefined) patch.cron = validateCron(input.cron);
  if (input.cwd !== undefined) patch.cwd = validateCwd(input.cwd);
  if (input.prompt !== undefined) patch.prompt = validatePrompt(input.prompt);
  if (input.enabled !== undefined) patch.enabled = !!input.enabled;
  if (input.provider !== undefined) patch.provider = validateOptionalString("provider", input.provider);
  if (input.modelId !== undefined) patch.modelId = validateOptionalString("modelId", input.modelId);
  if (input.thinkingLevel !== undefined) patch.thinkingLevel = validateOptionalString("thinkingLevel", input.thinkingLevel);
  if (input.toolNames !== undefined) patch.toolNames = validateToolNames(input.toolNames);

  const merged: ScheduledTask = { ...existing, ...patch };
  const nextRunAt = computeNextRun(merged.cron, merged.enabled);

  getSchedulerDb()
    .prepare(
      `UPDATE scheduled_tasks SET
        name = ?, cron = ?, cwd = ?, prompt = ?, enabled = ?,
        provider = ?, model_id = ?, thinking_level = ?, tool_names = ?,
        updated_at = ?, next_run_at = ?
       WHERE id = ?`
    )
    .run(
      merged.name, merged.cron, merged.cwd, merged.prompt, merged.enabled ? 1 : 0,
      merged.provider, merged.modelId, merged.thinkingLevel,
      merged.toolNames ? JSON.stringify(merged.toolNames) : null,
      Date.now(), nextRunAt, input.id,
    );

  log.info("task updated", { id: input.id });
  return getTask(input.id)!;
}

export function deleteTask(id: string): void {
  const db = getSchedulerDb();
  const res = db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
  if (res.changes === 0) throw new SchedulerNotFoundError(id);
  log.info("task deleted", { id });
}

export function setEnabled(id: string, enabled: boolean): ScheduledTask {
  return updateTask({ id, enabled });
}

export function listRuns(taskId: string, limit: number = DEFAULT_RUNS_LIMIT): TaskRun[] {
  const db = getSchedulerDb();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT id, task_id, started_at, ended_at, status, reply_text, error, session_id, duration_ms
         FROM task_runs
        WHERE task_id = ?
        ORDER BY started_at DESC
        LIMIT ?`
    )
    .all(taskId, safeLimit) as Array<{
      id: string;
      task_id: string;
      started_at: number;
      ended_at: number | null;
      status: TaskRunStatus;
      reply_text: string | null;
      error: string | null;
      session_id: string | null;
      duration_ms: number | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    replyText: r.reply_text,
    error: r.error,
    sessionId: r.session_id,
    durationMs: r.duration_ms,
  }));
}

export function getRun(runId: string): TaskRun | null {
  const db = getSchedulerDb();
  const row = db
    .prepare(
      `SELECT id, task_id, started_at, ended_at, status, reply_text, error, session_id, duration_ms
         FROM task_runs WHERE id = ?`
    )
    .get(runId) as
    | {
        id: string;
        task_id: string;
        started_at: number;
        ended_at: number | null;
        status: TaskRunStatus;
        reply_text: string | null;
        error: string | null;
        session_id: string | null;
        duration_ms: number | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    replyText: row.reply_text,
    error: row.error,
    sessionId: row.session_id,
    durationMs: row.duration_ms,
  };
}

export function recordRunStart(taskId: string): TaskRun {
  const id = newId();
  const startedAt = Date.now();
  getSchedulerDb()
    .prepare(
      `INSERT INTO task_runs (id, task_id, started_at, status) VALUES (?, ?, ?, 'running')`
    )
    .run(id, taskId, startedAt);
  return {
    id,
    taskId,
    startedAt,
    endedAt: null,
    status: "running",
    replyText: null,
    error: null,
    sessionId: null,
    durationMs: null,
  };
}

export function recordRunEnd(runId: string, input: RecordRunEndInput): TaskRun {
  const now = Date.now();
  const existing = getRun(runId);
  if (!existing) throw new SchedulerNotFoundError(runId);
  const durationMs = input.durationMs ?? now - existing.startedAt;
  getSchedulerDb()
    .prepare(
      `UPDATE task_runs SET
        ended_at = ?, status = ?, reply_text = ?, error = ?, session_id = ?, duration_ms = ?
       WHERE id = ?`
    )
    .run(now, input.status, input.replyText ?? null, input.error ?? null, input.sessionId ?? null, durationMs, runId);

  // Update last_run_at + last_run summary on the parent task
  getSchedulerDb()
    .prepare("UPDATE scheduled_tasks SET last_run_at = ? WHERE id = ?")
    .run(now, existing.taskId);

  return getRun(runId)!;
}