/**
 * Scheduling loop for the background scheduler.
 *
 * Strategy mirrors `lib/wechat/monitor.ts`: a self-rescheduling
 * `setTimeout` (not `setInterval`, to avoid drift). Each tick:
 *
 *   1. Load all enabled tasks from the DB.
 *   2. Find the soonest `next_run_at`.
 *   3. setTimeout until that instant.
 *   4. On wake, fire any due tasks (in scheduled order), update each
 *      task's `next_run_at`, and re-arm.
 *
 * The API routes call `reschedule()` after any CRUD so newly-created or
 * edited tasks are picked up without waiting for the current timer.
 */

import { Cron } from "croner";
import { getSchedulerDb } from "@/lib/scheduler-db";
import { recordRunStart, type ScheduledTask } from "@/lib/scheduler-store";
import { runTask } from "./runner";
import { createLogger } from "@/lib/logger";

const log = createLogger("scheduler/loop");

let timer: ReturnType<typeof setTimeout> | null = null;

export function isLoopRunning(): boolean {
  return timer !== null;
}

/** Start the scheduling loop. Idempotent. */
export function ensureLoop(): void {
  if (timer !== null) return;
  log.info("scheduler loop starting");
  scheduleNext(0);
}

/** Stop the scheduling loop. Safe to call when not running. */
export function stopLoop(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
    log.info("scheduler loop stopped");
  }
}

/**
 * Re-arm the timer as soon as possible. Called from the API after CRUD so
 * a newly-created task isn't held back by a long-pending timer.
 */
export function reschedule(): void {
  if (timer === null) {
    ensureLoop();
    return;
  }
  clearTimeout(timer);
  timer = null;
  scheduleNext(0);
}

interface TaskRow {
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
}

function rowToTask(row: TaskRow): ScheduledTask {
  let toolNames: string[] | null = null;
  if (row.tool_names) {
    try {
      const parsed = JSON.parse(row.tool_names);
      if (Array.isArray(parsed)) toolNames = parsed as string[];
    } catch {
      // ignore — store handles parse
    }
  }
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    cwd: row.cwd,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    provider: row.provider,
    modelId: row.model_id,
    thinkingLevel: row.thinking_level,
    toolNames,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastRunStatus: null,
    unreadCount: 0,
  };
}

function loadDueTasks(now: number): ScheduledTask[] {
  const rows = getSchedulerDb()
    .prepare(
      `SELECT id, name, cron, cwd, prompt, enabled, provider, model_id,
              thinking_level, tool_names, created_at, updated_at,
              last_run_at, next_run_at
         FROM scheduled_tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC`,
    )
    .all(now) as TaskRow[];
  return rows.map(rowToTask);
}

function loadNextWake(): number | null {
  const row = getSchedulerDb()
    .prepare(
      `SELECT MIN(next_run_at) AS next FROM scheduled_tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL`,
    )
    .get() as { next: number | null };
  return row.next;
}

function advanceNextRun(taskId: string, cron: string): void {
  // Compute via croner and persist. If cron is invalid, leave next_run_at
  // unchanged — the task will be re-evaluated next reschedule.
  try {
    const next = new Cron(cron).nextRun();
    getSchedulerDb()
      .prepare("UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?")
      .run(next ? next.getTime() : null, taskId);
  } catch (err) {
    log.warn("failed to advance next_run_at", { taskId, cron, error: String(err) });
  }
}

function scheduleNext(delayMs: number): void {
  if (timer !== null) return;
  const ms = Math.max(0, Math.floor(delayMs));
  timer = setTimeout(tick, ms);
  if (typeof timer.unref === "function") timer.unref();
}

async function tick(): Promise<void> {
  timer = null;
  const now = Date.now();
  const due = loadDueTasks(now);
  if (due.length > 0) {
    log.info("firing scheduled tasks", { count: due.length });
    for (const task of due) {
      const run = recordRunStart(task.id);
      // Advance the task's next_run_at BEFORE running, so an overlapping
      // tick (if any) doesn't see it as due again.
      advanceNextRun(task.id, task.cron);
      // Fire-and-forget per task; runner.ts handles its own FIFO.
      void runTask(task, run.id);
    }
  }
  // Re-arm
  const nextWake = loadNextWake();
  if (nextWake === null) {
    log.debug("no enabled tasks; loop idle");
    return;
  }
  const delay = Math.max(0, nextWake - Date.now());
  scheduleNext(delay);
}