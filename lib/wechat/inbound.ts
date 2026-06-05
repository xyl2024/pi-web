/**
 * Inbound WeChat message handler.
 *
 * This is the heart of the WeChat channel. Two callers:
 *   - `app/api/weixin/inbound/route.ts` — HTTP entry, for external triggers
 *   - `lib/wechat/monitor.ts`           — background poller, internal call
 *
 * Flow per message (R3 / B2 / L2 / N1):
 *   1. If text === "/new": clear currentSessionId, log the command, and
 *      reply "session reset". The next real WeChat message will see no
 *      binding and cold-start on its own — that message becomes the first
 *      turn of the new session, so /new itself never reaches the agent.
 *   2. Otherwise reuse currentSessionId, or cold-start if missing.
 *   3. POST /api/agent/[id] with { type: "prompt", message: text }.
 *   4. Best-effort sendtyping() to the user.
 *   5. Open SSE /api/agent/[id]/events, accumulate assistant text, and on
 *      `agent_end` send the full reply back via sendTextMessage.
 *   6. On any error, send a brief failure notice to the user.
 *
 * Side effects on state:
 *   - state.setCurrentSession(id) after every successful cold-start.
 *   - state.setCurrentSession(null) on /new (clears the binding).
 *   - state.recordContact(...) is called by the monitor before this is invoked.
 *   - logSessionEvent(...) writes a JSONL line for every lifecycle step.
 */
import { state, api } from "./index";
import { logSessionEvent } from "./sessions-log";
import { createLogger } from "@/lib/logger";

const log = createLogger("wechat/inbound");

const PI_BASE = process.env.PI_WEB_BASE_URL ?? "http://127.0.0.1:30141";

/** A 60s safety net — even if the SSE stream misbehaves we won't wait forever. */
const SSE_TIMEOUT_MS = 5 * 60 * 1000;

/** Plain HTTP wrapper that throws on non-2xx with a readable message. */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${url} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

interface AgentNewResult {
  success: boolean;
  sessionId: string;
}

interface AgentCommandResult {
  success: boolean;
  data?: unknown;
}

interface SsseEvent {
  type: string;
  // Some events carry content arrays of typed blocks.
  content?: Array<{ type?: string; text?: string }>;
  // agent_end carries the full message snapshot.
  messages?: unknown;
  // Agent-end error payload, when the run failed.
  error?: string;
}

/**
 * Cold-start a fresh session in the current workspace, with PRESET_FULL tools
 * and the default model from settings.json (K1=c, K2=a).
 */
async function coldStart(workspaceId: string, firstMessage: string): Promise<string> {
  const result = await postJson<AgentNewResult>(`${PI_BASE}/api/agent/new`, {
    cwd: workspaceId,
    type: "prompt",
    message: firstMessage,
    toolNames: "all",
  });
  if (!result.sessionId) throw new Error("cold-start returned no sessionId");
  return result.sessionId;
}

/** Send a prompt to an existing session. */
async function sendPrompt(sessionId: string, message: string): Promise<void> {
  await postJson<AgentCommandResult>(`${PI_BASE}/api/agent/${encodeURIComponent(sessionId)}`, {
    type: "prompt",
    message,
  });
}

/**
 * Open the SSE event stream and wait for `agent_end`. Returns the final
 * assistant reply text by walking `event.messages` backwards and joining
 * the text content blocks of the last assistant message. This is the
 * stable path: pi guarantees the full `messages` snapshot on agent_end,
 * whereas the per-token `message_update` events vary in shape between
 * providers (Anthropic / OpenAI / Google all format `assistantMessageEvent`
 * differently).
 *
 * If `agent_end` carries an `error` field on the last assistant message
 * (stopReason === "error" / "aborted"), throws so the caller can surface
 * it to the user.
 */
async function waitForAgentReply(sessionId: string): Promise<string> {
  const url = `${PI_BASE}/api/agent/${encodeURIComponent(sessionId)}/events`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SSE_TIMEOUT_MS);

  let agentEndMessages: AgentMessage[] | null = null;
  let agentEndError: string | null = null;

  try {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamDone = false;

    while (!streamDone) {
      const { value, done: rDone } = await reader.read();
      streamDone = rDone;
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines: string[] = [];
          for (const line of rawEvent.split("\n")) {
            if (line.startsWith("data: ")) dataLines.push(line.slice(6));
          }
          if (dataLines.length === 0) continue;
          const payload = dataLines.join("\n");
          if (!payload) continue;
          let event: SsseEvent;
          try {
            event = JSON.parse(payload) as SsseEvent;
          } catch {
            continue;
          }
          logSessionEvent({
            kind: "agent_event",
            sessionId,
            fromUserId: "",
            eventType: event.type,
          });
          if (event.type === "agent_end") {
            if (Array.isArray(event.messages)) {
              agentEndMessages = event.messages as AgentMessage[];
            }
            if (typeof event.error === "string") agentEndError = event.error;
            controller.abort();
            break;
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name !== "AbortError") {
      log.warn("SSE stream error", { sessionId, error: String(err) });
    }
  } finally {
    clearTimeout(timer);
  }

  if (agentEndError) throw new Error(agentEndError);
  if (!agentEndMessages) {
    throw new Error("SSE ended without agent_end event");
  }

  // Walk backwards to find the last assistant message.
  for (let i = agentEndMessages.length - 1; i >= 0; i--) {
    const m = agentEndMessages[i];
    if (m.role !== "assistant") continue;
    // Surface stopReason="error" / "aborted" with the provider's errorMessage
    if (m.stopReason === "error" || m.stopReason === "aborted") {
      throw new Error(m.errorMessage || `assistant stopReason=${m.stopReason}`);
    }
    const text = m.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text) return text;
  }
  return "";
}

// Minimal local types — we only need to walk the well-known shape returned
// by the pi SSE endpoint. They are compatible with @earendil-works/pi-ai's
// AssistantMessage / TextContent but defined inline to avoid pulling the
// full type graph into this file.
interface TextBlock { type: "text"; text: string }
interface AssistantMsg {
  role: "assistant";
  content: Array<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}
type AgentMessage = AssistantMsg | { role: "user" | "toolResult"; [k: string]: unknown };

export interface InboundMessage {
  fromUserId: string;
  text: string;
  contextToken?: string;
}

/**
 * Main entry. Resolves once the reply has been sent to WeChat (or attempts
 * have been exhausted). Never throws — all errors are logged and surfaced
 * to the user via a best-effort failure message.
 */
export async function handleInbound(msg: InboundMessage): Promise<void> {
  const startedAt = Date.now();
  logSessionEvent({
    kind: "inbound",
    fromUserId: msg.fromUserId,
    text: msg.text,
    contextToken: msg.contextToken,
  });

  const account = state.loadAccount();
  if (!account) {
    log.warn("inbound dropped — no account configured", { fromUserId: msg.fromUserId });
    return;
  }
  if (!account.userId) {
    log.warn("inbound dropped — account missing userId", { fromUserId: msg.fromUserId });
    return;
  }
  if (!account.currentWorkspaceId) {
    log.warn("inbound dropped — no current workspace", { fromUserId: msg.fromUserId });
    await safeReply(account, msg.fromUserId, "❌ 当前未设置 workspace，请到 pi-web 微信面板里选一个。", msg.contextToken);
    return;
  }

  const isNew = msg.text.trim() === "/new";
  if (isNew) {
    // /new is a reset command: clear currentSessionId and acknowledge. We
    // do NOT cold-start here — the next inbound WeChat message will see
    // no currentSessionId, fall through the cold-start branch, and become
    // the first turn of a fresh session. (N1)
    logSessionEvent({ kind: "command", fromUserId: msg.fromUserId, command: "/new" });
    state.setCurrentSession(null);
    await safeReply(
      account,
      msg.fromUserId,
      "✅ 已重置，下条消息开始新会话。",
      msg.contextToken,
    );
    return;
  }

  let sessionId: string | null = account.currentSessionId ?? null;

  // B2: send typing as soon as we know we're about to do work.
  void fireTyping(account, msg.fromUserId, msg.contextToken);

  try {
    if (!sessionId) {
      sessionId = await coldStart(account.currentWorkspaceId, msg.text);
      state.setCurrentSession(sessionId);
      logSessionEvent({
        kind: "cold_start",
        sessionId,
        cwd: account.currentWorkspaceId,
        fromUserId: msg.fromUserId,
      });
    } else {
      logSessionEvent({
        kind: "send",
        sessionId,
        fromUserId: msg.fromUserId,
        text: msg.text,
      });
      await sendPrompt(sessionId, msg.text);
    }

    const replyText = await waitForAgentReply(sessionId);
    const durationMs = Date.now() - startedAt;
    logSessionEvent({
      kind: "agent_end",
      sessionId,
      fromUserId: msg.fromUserId,
      durationMs,
      replyText,
    });
    if (!replyText) {
      await safeReply(account, msg.fromUserId, "（agent 没有产生输出）", msg.contextToken);
      return;
    }
    await safeReply(account, msg.fromUserId, replyText, msg.contextToken);
  } catch (err) {
    const errorStr = err instanceof Error ? err.message : String(err);
    logSessionEvent({
      kind: "agent_error",
      sessionId: sessionId ?? "(none)",
      fromUserId: msg.fromUserId,
      error: errorStr,
    });
    log.error("inbound failed", { fromUserId: msg.fromUserId, sessionId, error: errorStr });
    await safeReply(account, msg.fromUserId, `❌ 处理失败：${errorStr.slice(0, 200)}`, msg.contextToken);
  }
}

async function fireTyping(
  account: { baseUrl: string; token: string },
  to: string,
  contextToken?: string,
): Promise<void> {
  try {
    await api.sendTyping({ baseUrl: account.baseUrl, token: account.token, to, contextToken });
  } catch (err) {
    log.debug("sendtyping failed (ignored)", { to, error: String(err) });
  }
}

async function safeReply(
  account: { baseUrl: string; token: string; userId?: string },
  to: string,
  text: string,
  contextToken?: string,
): Promise<void> {
  try {
    const resp = await api.sendTextMessage({
      baseUrl: account.baseUrl,
      token: account.token,
      to,
      text,
      contextToken,
      clientId: api.newClientId(),
    });
    logSessionEvent({
      kind: "reply",
      sessionId: "(reply)",
      fromUserId: to,
      length: text.length,
    });
    void resp; // currently empty, kept for future message_id extraction
  } catch (err) {
    const errStr = err instanceof Error ? err.message : String(err);
    log.warn("reply failed", { to, error: errStr });
    logSessionEvent({
      kind: "reply_failed",
      sessionId: "(reply)",
      fromUserId: to,
      error: errStr,
    });
    // E4 detection: 401/expired → mark account as expired
    if (/401|expired|invalid|token/i.test(errStr)) {
      state.markAccountExpired();
    }
  }
}
