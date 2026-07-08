/**
 * Executes one scheduled task: cold-start a fresh pi session, send the
 * configured prompt, wait for `agent_end`, and record the outcome on the
 * pre-created `task_runs` row.
 *
 * Pattern mirrors `lib/wechat/inbound.ts:coldStart` + `waitForAgentReply`.
 * The key difference: every scheduled run uses a brand-new session (the
 * scheduler must never share a wrapper with a user's open session), so we
 * always go through `coldStart`.
 *
 * Concurrency: a per-task FIFO chain (`taskChains`) prevents the same task
 * from running twice in parallel if a previous run is still in flight.
 * Different tasks run independently.
 */

import { existsSync } from "fs";
import { startRpcSession } from "@/lib/rpc-manager";
import type { AgentEvent } from "@/lib/rpc-manager";
import { recordRunEnd, type ScheduledTask } from "@/lib/scheduler-store";
import { pushMessage } from "@/lib/inbox-store";
import { createLogger } from "@/lib/logger";

const log = createLogger("scheduler/runner");

/** Match WeChat's safety net — even slow tasks shouldn't hang forever. */
const AGENT_END_TIMEOUT_MS = 5 * 60 * 1000;

interface TextBlock { type: string; text?: string }
interface AssistantMsg {
  role: string;
  content: Array<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

/** Per-task FIFO chain so two overlapping triggers don't run concurrently. */
const taskChains = new Map<string, Promise<void>>();

/**
 * Inbox is a side channel — pushMessage can throw InboxValidationError on
 * malformed input. The scheduler must never be poisoned by inbox failures,
 * so we swallow the error and log it.
 */
function safePush(taskId: string, input: Parameters<typeof pushMessage>[0]): void {
  try {
    pushMessage(input);
  } catch (err) {
    log.warn("inbox push failed", { taskId, error: String(err) });
  }
}

export function runTask(task: ScheduledTask, runId: string): Promise<void> {
  const prev = taskChains.get(task.id) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined) // never poison the chain
    .then(() => executeRun(task, runId));
  taskChains.set(task.id, next);
  return next;
}

async function executeRun(task: ScheduledTask, runId: string): Promise<void> {
  const startedAt = Date.now();
  log.info("run start", { taskId: task.id, runId, cwd: task.cwd });

  if (!existsSync(task.cwd)) {
    const msg = `cwd missing: ${task.cwd}`;
    log.error("run aborted", { taskId: task.id, runId, error: msg });
    recordRunEnd(runId, { status: "error", error: msg, durationMs: Date.now() - startedAt });
    safePush(task.id, {
      source: "scheduler",
      level: "error",
      title: task.name,
      payload: { body: `cwd missing: ${task.cwd}` },
    });
    return;
  }

  let sessionId: string | null = null;
  try {
    const tempKey = `__sched__${runId}`;
    const { session, realSessionId } = await startRpcSession(
      tempKey,
      "",
      task.cwd,
      task.toolNames ?? "all",
    );
    sessionId = realSessionId;
    recordRunEnd(runId, { sessionId, status: "running", durationMs: Date.now() - startedAt });

    if (task.provider && task.modelId) {
      await session.send({ type: "set_model", provider: task.provider, modelId: task.modelId });
    }
    if (task.thinkingLevel) {
      await session.send({ type: "set_thinking_level", level: task.thinkingLevel });
    }

    // session.send for prompt is fire-and-forget; results arrive via onEvent
    session.send({ type: "prompt", message: task.prompt }).catch(() => undefined);

    const reply = await waitForAgentReply(session, runId);
    const durationMs = Date.now() - startedAt;
    log.info("run success", { taskId: task.id, runId, sessionId, durationMs });
    recordRunEnd(runId, {
      status: "success",
      replyText: reply || null,
      sessionId,
      durationMs,
    });
    safePush(task.id, {
      source: "scheduler",
      level: "info",
      title: task.name,
      payload: { body: reply ? reply.slice(0, 200) : "Task completed" },
    });
  } catch (err) {
    const errorStr = err instanceof Error ? err.message : String(err);
    const isTimeout = /timed out/i.test(errorStr);
    const status = isTimeout ? "timeout" : "error";
    const durationMs = Date.now() - startedAt;
    log.error("run failed", { taskId: task.id, runId, sessionId, status, error: errorStr });
    recordRunEnd(runId, { status, error: errorStr, sessionId, durationMs });
    safePush(task.id, {
      source: "scheduler",
      level: isTimeout ? "warn" : "error",
      title: task.name,
      payload: { body: errorStr.slice(0, 200) },
    });
  }
}

/**
 * Subscribe to the wrapper's event stream and resolve on `agent_end`,
 * extracting the last assistant message text. Mirrors
 * `lib/wechat/inbound.ts:waitForAgentReply` exactly.
 */
function waitForAgentReply(
  session: { onEvent: (cb: (event: AgentEvent) => void) => () => void },
  runId: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      unsubscribe();
      reject(new Error(`agent_end timed out after ${AGENT_END_TIMEOUT_MS}ms`));
    }, AGENT_END_TIMEOUT_MS);

    const unsubscribe = session.onEvent((event: AgentEvent) => {
      if (event.type !== "agent_end") return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();

      const error = typeof event.error === "string" ? event.error : null;
      if (error) {
        reject(new Error(error));
        return;
      }
      const messages = Array.isArray((event as Record<string, unknown>).messages)
        ? ((event as Record<string, unknown>).messages as AssistantMsg[])
        : null;
      if (!messages) {
        // No messages snapshot — treat as success with empty reply so the run
        // is recorded. This can happen if pi changed its event shape.
        log.warn("agent_end without messages snapshot", { runId });
        resolve("");
        return;
      }

      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== "assistant") continue;
        if (m.stopReason === "error" || m.stopReason === "aborted") {
          reject(new Error(m.errorMessage || `assistant stopReason=${m.stopReason}`));
          return;
        }
        const text = m.content
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        resolve(text);
        return;
      }
      resolve("");
    });
  });
}