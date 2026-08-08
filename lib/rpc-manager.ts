import { createAgentSession, DefaultResourceLoader, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import type { AgentSessionLike, ToolInfo } from "./pi-types";
import { createLogger, elapsedMs } from "./logger";
import { readConfig } from "./config";
import { existsSync } from "node:fs";
import path from "node:path";

import { recordCall } from "./token-audit-store";
import { buildTodoTools } from "./todo-tools";
import { readEnabledTodoTools } from "./todo-tools-config";
import { buildShowFileTool } from "./show-file-tool";
import { buildAgentTodoTool } from "./agent-todo-tool";
import { readEnabledCustomTools } from "./custom-tools-config";
import { matchDangerousPattern, getDangerousPatternTimeoutMs } from "./dangerous-patterns";

const log = createLogger("rpc-manager");
type ToolSelection = string[] | "all";

export type PermissionDecision = "allow_once" | "allow_similar" | "deny";

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  reject: (reason: string) => void;
  ruleName: string;
  command: string;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export interface PermissionRequestEvent {
  type: "permission_request";
  toolCallId: string;
  ruleName: string;
  command: string;
}

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  // True between agent_start and agent_end (and during compaction). Spans the
  // whole turn including tool calls so the sidebar dot covers the full
  // "agent is busy" window, not just the model streaming phase.
  private _running = false;
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private allowedThisSession: Set<string> = new Set();

  constructor(public readonly inner: AgentSessionLike) {}

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  /** True while the agent is between agent_start and agent_end (or compacting). */
  isRunning(): boolean {
    return this._running;
  }

  start(): void {
    log.info("agent wrapper started", {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile || undefined,
    });
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.resetIdleTimer();
      this.updateRunningState(event);
      for (const l of this.listeners) l(event);
    });
    this.resetIdleTimer();
  }

  private updateRunningState(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
      case "compaction_start":
      case "auto_compaction_start":
        this._running = true;
        break;
      case "agent_end":
      case "compaction_end":
      case "auto_compaction_end":
        this._running = false;
        break;
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.destroy(), 10 * 60 * 1000);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  /**
   * Block a tool call until the user makes a decision. Emits a synthetic
   * permission_request event to subscribers and returns a promise that
   * resolves with the user's decision (or 'deny' on timeout / destroy).
   */
  requestPermission(toolCallId: string, ruleName: string, command: string): Promise<PermissionDecision> {
    if (this.pendingPermissions.has(toolCallId)) {
      // Idempotent: a re-entry shouldn't happen, but if it does, return the existing promise.
      return new Promise<PermissionDecision>((resolve, reject) => {
        const existing = this.pendingPermissions.get(toolCallId)!;
        existing.resolve = (d) => { resolve(d); existing.resolve = () => {}; };
        existing.reject = (r) => { reject(r); existing.reject = () => {}; };
      });
    }
    const timeoutMs = getDangerousPatternTimeoutMs();
    const promise = new Promise<PermissionDecision>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const pending = this.pendingPermissions.get(toolCallId);
        if (!pending) return;
        this.pendingPermissions.delete(toolCallId);
        log.warn("permission request timed out, auto-denying", { toolCallId, ruleName });
        resolve("deny");
      }, timeoutMs);
      const entry: PendingPermission = {
        resolve,
        reject,
        ruleName,
        command,
        timeoutHandle,
      };
      this.pendingPermissions.set(toolCallId, entry);
    });
    const event: PermissionRequestEvent = {
      type: "permission_request",
      toolCallId,
      ruleName,
      command,
    };
    for (const l of this.listeners) {
      try {
        l(event as unknown as AgentEvent);
      } catch {
        // listener errors must not break permission flow
      }
    }
    log.info("permission requested", { toolCallId, ruleName });
    return promise;
  }

  resolvePermission(toolCallId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(toolCallId);
    if (!pending) return false;
    this.pendingPermissions.delete(toolCallId);
    clearTimeout(pending.timeoutHandle);
    if (decision === "allow_similar") this.allowedThisSession.add(pending.ruleName);
    pending.resolve(decision);
    log.info("permission resolved", { toolCallId, decision });
    return true;
  }

  isRuleAllowedThisSession(ruleName: string): boolean {
    return this.allowedThisSession.has(ruleName);
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;
    log.debug("agent command dispatch", { sessionId: this.sessionId, type });

    switch (type) {
      case "prompt": {
        // Fire and forget — events come via subscribe. Rejections surface
        // as a synthetic prompt_failed event so the client can react instead
        // of silently hanging (e.g. missing API key, unregistered model).
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        this.inner
          .prompt(command.message as string, promptImages?.length ? { images: promptImages } : undefined)
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            log.warn("prompt failed", { sessionId: this.sessionId, error });
            for (const l of this.listeners) {
              try {
                l({ type: "prompt_failed", error: message } as unknown as AgentEvent);
              } catch {
                // listener errors must not break the dispatch loop
              }
            }
          });
        return null;
      }

      case "abort":
        await this.inner.abort();
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: 0,
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const runtime = this.inner.modelRuntime;
        const model = runtime.getModel(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }
      case "navigate_tree": {
        const result = await this.inner.navigateTree(command.targetId as string, {});
        log.info("navigate tree completed", {
          sessionId: this.sessionId,
          targetId: command.targetId,
          cancelled: result.cancelled,
        });
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        return null;
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "set_tools": {
        const toolNames = command.toolNames as ToolSelection;
        if (toolNames === "all") {
          this.inner.setActiveToolsByName(this.inner.getAllTools().map((t) => t.name));
        } else if (Array.isArray(toolNames)) {
          this.inner.setActiveToolsByName(toolNames);
        }
        return null;
      }

      case "permission_decision": {
        const toolCallId = command.toolCallId as string;
        const decision = command.decision as PermissionDecision;
        const resolved = this.resolvePermission(toolCallId, decision);
        return { resolved };
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    this._running = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unsubscribe?.();
    this.onDestroyCallback?.();
    for (const [, pending] of this.pendingPermissions) {
      clearTimeout(pending.timeoutHandle);
      pending.reject("destroyed");
    }
    this.pendingPermissions.clear();
    this.allowedThisSession.clear();
    log.info("agent wrapper destroyed", {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile || undefined,
    });
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

/**
 * Snapshot of which registered sessions are currently running.
 * Reads `globalThis.__piSessions` only — no disk I/O — so callers can poll
 * this cheaply (the SessionSidebar uses it every 3s to render a spinner on
 * the active row).
 */
export function listRunningRpcSessions(): { id: string; running: boolean }[] {
  const out: { id: string; running: boolean }[] = [];
  for (const [id, wrapper] of getRegistry()) {
    out.push({ id, running: wrapper.isRunning() });
  }
  return out;
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * Pass toolNames to pre-configure active tools (empty array = all tools disabled, "all" = every available tool).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames: ToolSelection = "all",
  source: "user" | "scheduled" = "user"
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();
  const startedAt = Date.now();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) {
    log.debug("reuse live agent session", { sessionId });
    return { session: existing, realSessionId: sessionId };
  }

  const inflight = locks.get(sessionId);
  if (inflight) {
    log.debug("reuse inflight agent session start", { sessionId });
    return inflight;
  }

  const starting = (async () => {
    log.info("start agent session", {
      sessionId,
      sessionFile: sessionFile || undefined,
      cwd,
      requestedToolCount: toolNames === "all" ? "all" : toolNames?.length,
    });
    const { SessionManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const agentDir = getAgentDir();

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(cwd, undefined);
    const isNewSession = !sessionFile;

    // Inline extension that mirrors every outgoing provider request and
    // its response headers into our in-memory ring buffer. Each session
    // gets its own loader/closure, so `capturedSessionId` only ever holds
    // the id for this wrapper.
    let capturedSessionId: string | null = null;
    // Source of this session (user-driven tab vs scheduler-fired task).
    // Captured once at construction so token-audit rows can attribute cost.
    const capturedSource: "user" | "scheduled" = source;
    // Forward reference — the tool_call handler runs inside the agent's
    // extension context but needs to call back into the wrapper to surface
    // permission requests and resolve them. Set immediately after the
    // wrapper is constructed below. Using a box object so TypeScript does
    // not narrow the type to `never` inside the closure.
    const wrapperRef: { current: AgentSessionWrapper | null } = { current: null };
    // Snapshot which agent-side custom tools are enabled for this session.
    // Read once here so the value is stable across the IIFE (an in-flight
    // config write shouldn't change the tool set mid-session). Custom
    // tools are passed to createAgentSession below — already-running
    // sessions keep their original set even if the user toggles a switch.
    const enabledCustom = readEnabledCustomTools();
    // Build path list for vendored built-in extensions. Read once per session start.
    const additionalExtensionPaths: string[] = [];
    // APPEND_SYSTEM.md loader toggle (see PiWorkConfig.append_system): when the
    // user has disabled it, we hand DefaultResourceLoader an explicit empty
    // array so the `??` on `appendSystemPromptSource` short-circuits and
    // `discoverAppendSystemPromptFile()` never runs. Read once per session
    // start — toggling at runtime only affects sessions started afterward.
    let appendSystemPromptLoaderOption: string[] | undefined;
    try {
      const cfg = readConfig();
      if (cfg.extensions.clawd_on_desk.enabled) {
        // DefaultResourceLoader passes additionalExtensionPaths directly to
        // jiti.import without doing directory→index.ts resolution, so we must
        // hand it the file path, not the directory.
        const clawdEntry = path.join(process.cwd(), "extensions", "clawd-on-desk", "index.ts");
        if (existsSync(clawdEntry)) {
          additionalExtensionPaths.push(clawdEntry);
        } else {
          log.warn("clawd-on-desk enabled but vendored entry missing", { path: clawdEntry });
        }
      }
      if (!cfg.append_system.enabled) {
        appendSystemPromptLoaderOption = [];
      }
    } catch {
      // readConfig already logs and falls back to defaults; this catch is defensive only.
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths,
      // Pass `[]` (not `undefined`) when the toggle is off — the loader's
      // `??` on appendSystemPromptSource treats an explicit empty array as
      // "user-supplied, nothing to append" and skips file discovery.
      // Leaving `undefined` here would fall through to discovery.
      ...(appendSystemPromptLoaderOption !== undefined
        ? { appendSystemPrompt: appendSystemPromptLoaderOption }
        : {}),
      extensionFactories: [
        (pi) => {
          pi.on("tool_call", async (event) => {
            if (!isToolCallEventType("bash", event)) return;
            const command = event.input.command;
            const match = matchDangerousPattern(command);
            if (!match) return;
            const w = wrapperRef.current;
            if (!w) return;
            if (w.isRuleAllowedThisSession(match.ruleName)) return;
            const decision = await w.requestPermission(event.toolCallId, match.ruleName, command);
            if (decision === "deny") {
              return { block: true, reason: "Denied by user" };
            }
            // 'allow_once' and 'allow_similar' both let the tool run.
            // 'allow_similar' was already recorded on the wrapper.
            return undefined;
          });
        },
        // ── Token audit capture ──────────────────────────────────────────
        // One row per assistant `message_end`. Uses `INSERT OR IGNORE` against
        // UNIQUE(session_id, message_id) so retries / SSE reconnects / compaction
        // replays never inflate the audit log.
        //
        // duration_ms = (Date.now() at hook time) − msg.timestamp. `msg.timestamp`
        // is when the LLM finalized the message internally; `Date.now()` is when
        // our hook fires immediately after — gap is just RPC event dispatch
        // (~few ms), so this is a tight upper bound on real call latency.
        //
        // We deliberately do NOT use `before_provider_request` for the start
        // stamp: in observed runs, that event can fire *after* `msg.timestamp`
        // by a few ms (likely pi-internal preflight + a second dispatch), which
        // produces negative durations after clamping. Computing duration from
        // `msg.timestamp` + hook time is strictly non-negative and accurate.
        (pi) => {
          pi.on("message_end", (event) => {
            const ev = event as { message?: { role?: string; provider?: string; model?: string; api?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } }; timestamp?: number; stopReason?: string; errorMessage?: string } };
            const msg = ev.message;
            if (!msg || msg.role !== "assistant") return;
            if (!capturedSessionId) return;
            // AssistantMessage has no `id` field on the in-memory object — the
            // JSONL entry id is on the OUTER entry, not available to extensions.
            // Use `timestamp` (ms) as the dedup key; collisions only occur on
            // SDK replays (compaction, SSE reconnect), which is what we want to
            // dedupe via the UNIQUE(session_id, message_id) constraint.
            const finalizedAt = msg.timestamp ?? Date.now();
            const hookAt = Date.now();
            const u = msg.usage ?? {};
            const c = u.cost ?? {};
            const input = u.input ?? 0;
            const output = u.output ?? 0;
            const read = u.cacheRead ?? 0;
            const write = u.cacheWrite ?? 0;
            const costIn = c.input ?? 0;
            const costOut = c.output ?? 0;
            const costRead = c.cacheRead ?? 0;
            const costWrite = c.cacheWrite ?? 0;
            const costTotal =
              c.total ?? costIn + costOut + costRead + costWrite;
            try {
              recordCall({
                sessionId: capturedSessionId,
                messageId: String(finalizedAt),
                source: capturedSource,
                provider: msg.provider ?? "unknown",
                modelId: msg.model ?? "unknown",
                api: msg.api ?? null,
                // Store `finalizedAt` as `ts` for sorting/filtering. It is the
                // moment the LLM produced its final message — close enough to
                // "when this call happened" for human-scale audit purposes.
                ts: finalizedAt,
                inputTokens: input,
                outputTokens: output,
                cacheReadTokens: read,
                cacheWriteTokens: write,
                costInput: costIn,
                costOutput: costOut,
                costRead,
                costWrite,
                costTotal,
                durationMs: Math.max(0, hookAt - finalizedAt),
                error: msg.stopReason === "error" ? (msg.errorMessage ?? "error") : null,
              });
            } catch (e) {
              log.warn("token-audit record failed", {
                sessionId: capturedSessionId,
                error: String(e),
              });
            }
          });
        },
      ],
    });
    await resourceLoader.reload();

    const { session: inner } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager,
      resourceLoader,
      // Per-session customTools: user_todos_list / user_todo_description are
      // gated by ~/.pi-work/todo-tools.json (see todo-tools-config); the two
      // agent-side tools (show_file, agent_todo) are gated by
      // ~/.pi-work/config.yaml → custom_tools.enabled. Read at startRpcSession
      // time only — already-running sessions keep their original tool set.
      customTools: [
        ...buildTodoTools(readEnabledTodoTools()),
        ...(enabledCustom.has("show_file") ? buildShowFileTool() : []),
        ...(enabledCustom.has("agent_todo") ? buildAgentTodoTool() : []),
      ],
    });
    capturedSessionId = inner.sessionId as string;

    // Drop the cached /api/sessions list so the sidebar sees this new session
    // on its next refresh. Only needed when we actually created a new file —
    // re-opening an existing one doesn't change the set of sessions.
    if (isNewSession) {
      invalidateSessionListCache();
    }

    // Keep pi's full tool registry available so later switches to "all" can include
    // extension/custom tools, then set the active subset before the first prompt.
    // If "all" was requested, activate everything pi registered at runtime.
    if (toolNames === "all") {
      inner.setActiveToolsByName(inner.getAllTools().map((t: ToolInfo) => t.name));
    } else if (Array.isArray(toolNames)) {
      inner.setActiveToolsByName(toolNames);
    }

    // When all tools are disabled, clear the system prompt entirely.
    // pi's buildSystemPrompt always produces a non-empty prompt even with no tools;
    // the only way to truly clear it is to call agent.setSystemPrompt directly.
    if (Array.isArray(toolNames) && toolNames.length === 0) {
      inner.agent.state.systemPrompt = "";
    }

    const wrapper = new AgentSessionWrapper(inner);
    wrapperRef.current = wrapper;
    wrapper.start();

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    wrapper.onDestroy(() => {
      registry.delete(realSessionId);
      // Note: payload capture file is intentionally NOT cleared here.
      // It survives session unload and is only removed when the session
      // itself is deleted (see app/api/sessions/[id]/route.ts DELETE).
    });
    registry.set(realSessionId, wrapper);

    log.info("agent session started", {
      sessionId,
      realSessionId,
      sessionFile: realSessionFile,
      durationMs: elapsedMs(startedAt),
    });
    return { session: wrapper, realSessionId };
  })().catch((error) => {
    log.error("agent session start failed", {
      sessionId,
      sessionFile: sessionFile || undefined,
      cwd,
      error,
      durationMs: elapsedMs(startedAt),
    });
    throw error;
  }).finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
