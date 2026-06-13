import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { cacheSessionPath } from "./session-reader";
import type { AgentSessionLike, ToolInfo } from "./pi-types";
import { createLogger, elapsedMs } from "./logger";
import { readConfig, applyReplacements } from "./config";
import { recordRequest, recordResponse } from "./payload-capture";
import { buildTodoTools } from "./todo-tools";
import { readEnabledTodoTools } from "./todo-tools-config";
import { buildShowFileTool } from "./show-file-tool";

const log = createLogger("rpc-manager");
type ToolSelection = string[] | "all";

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

  start(): void {
    log.info("agent wrapper started", {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile || undefined,
    });
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.resetIdleTimer();
      for (const l of this.listeners) l(event);
    });
    this.resetIdleTimer();
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

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;
    log.debug("agent command dispatch", { sessionId: this.sessionId, type });

    switch (type) {
      case "prompt": {
        // Fire and forget — events come via subscribe
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        this.inner.prompt(command.message as string, promptImages?.length ? { images: promptImages } : undefined).catch(() => {});
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
          isCompacting: this.inner.isCompacting,
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
        const registry = this.inner.modelRegistry;
        const model = registry.find(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        const startedAt = Date.now();
        log.info("fork requested", { sessionId: this.sessionId, entryId });

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        log.info("fork completed", {
          sessionId: this.sessionId,
          newSessionId,
          newSessionFile,
          durationMs: elapsedMs(startedAt),
        });
        this.destroy();
        return { cancelled: false, newSessionId };
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

      case "compact": {
        const startedAt = Date.now();
        log.info("compaction requested", { sessionId: this.sessionId });
        // pi's compact() does not guard against empty messagesToSummarize — use findCutPoint
        // to pre-check and throw a clean error instead of generating a useless empty summary.
        const { findCutPoint, DEFAULT_COMPACTION_SETTINGS } = await import("@earendil-works/pi-coding-agent");
        const pathEntries = this.inner.sessionManager.getBranch() as Array<{ type: string }>;
        const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...this.inner.settingsManager.getCompactionSettings() };
        let prevCompactionIndex = -1;
        for (let i = pathEntries.length - 1; i >= 0; i--) {
          if (pathEntries[i].type === "compaction") { prevCompactionIndex = i; break; }
        }
        const boundaryStart = prevCompactionIndex + 1;
        const cutPoint = findCutPoint(pathEntries as never, boundaryStart, pathEntries.length, settings.keepRecentTokens);
        const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
        if (historyEnd <= boundaryStart) {
          throw new Error("Conversation too short to compact");
        }
        const result = await this.inner.compact(command.customInstructions as string | undefined);
        log.info("compaction completed", { sessionId: this.sessionId, durationMs: elapsedMs(startedAt) });
        return result;
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

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unsubscribe?.();
    this.onDestroyCallback?.();
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
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * Pass toolNames to pre-configure active tools (empty array = all tools disabled, "all" = every available tool).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames: ToolSelection = "all"
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

    // Inline extension that mirrors every outgoing provider request and
    // its response headers into our in-memory ring buffer. Each session
    // gets its own loader/closure, so `capturedSessionId` only ever holds
    // the id for this wrapper.
    let capturedSessionId: string | null = null;
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [
        (pi) => {
          pi.on("before_provider_request", (event) => {
            if (capturedSessionId) recordRequest(capturedSessionId, event.payload);
          });
          pi.on("after_provider_response", (event) => {
            if (capturedSessionId) recordResponse(capturedSessionId, event.status, event.headers);
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
      customTools: [...buildTodoTools(readEnabledTodoTools()), ...buildShowFileTool()],
    });
    capturedSessionId = inner.sessionId as string;

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

    // Apply user-configured system prompt replacements (pi-web feature).
    // Read from ~/.pi-web/config.yaml and apply literal string replacements.
    // Both _baseSystemPrompt and agent.state.systemPrompt must be updated:
    // pi-core's prompt() method resets agent.state.systemPrompt from _baseSystemPrompt
    // on every turn (line 815 of agent-session.js), so replacing only the latter
    // is lost on the first message.
    try {
      const config = readConfig();
      const spr = config.system_prompt_replacements;
      if (spr.enabled && spr.rules.length > 0) {
        const replaced = applyReplacements(
          inner.agent.state.systemPrompt ?? "",
          spr.rules,
        );
        inner.agent.state.systemPrompt = replaced;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (inner as any)._baseSystemPrompt = replaced;
      }
    } catch {
      // readConfig already logs and returns defaults on failure;
      // this catch is a safety net for unexpected errors.
    }

    const wrapper = new AgentSessionWrapper(inner);
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
