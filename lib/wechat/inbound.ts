/**
 * Inbound WeChat message handler.
 *
 * This is the heart of the WeChat channel. Two callers:
 *   - `app/api/weixin/inbound/route.ts` — HTTP entry, for external triggers
 *   - `lib/wechat/monitor.ts`           — background poller, internal call
 *
 * Concurrency: calls are serialized per-account via an in-memory FIFO
 * chain (see `inboundChains` below). The monitor fires `void handleInbound`
 * for every message in a getUpdates batch, and without the chain those
 * calls would race on the same AgentSessionWrapper in two ways:
 *   1. Cold-start race — two parallel calls both see currentSessionId
 *      null and call coldStart with different tempKeys, creating two
 *      orphan sessions. Serialized, the second call sees the first's
 *      setCurrentSession and reuses that session.
 *   2. Wrong-reply race — two parallel calls each subscribe to onEvent
 *      on the same wrapper. The first agent_end fires for both, both
 *      resolve with the same reply text, and the second call's actual
 *      reply is lost (no one listening for the second agent_end).
 *      Serialized, the second call's waitForAgentReply subscribes only
 *      after the first call's agent_end has already fired and been
 *      unsubscribed from.
 *
 * Flow per message (R3 / B2 / L2 / N1):
 *   1. If text === "/new": clear currentSessionId, log the command, and
 *      reply "session reset". The next real WeChat message will see no
 *      binding and cold-start on its own — that message becomes the first
 *      turn of the new session, so /new itself never reaches the agent.
 *   2. Otherwise reuse currentSessionId, or cold-start if missing.
 *   3. Send a prompt through the AgentSessionWrapper (startRpcSession +
 *      session.send, both in-process — no HTTP).
 *   4. Best-effort sendtyping() to the user.
 *   5. Subscribe via session.onEvent, wait for `agent_end`, and send the
 *      full reply back via sendTextMessage.
 *   6. On any error, send a brief failure notice to the user.
 *
 * Side effects on state:
 *   - state.setCurrentSession(id) after every successful cold-start.
 *   - state.setCurrentSession(null) on /new (clears the binding).
 *   - state.recordContact(...) is called by the monitor before this is invoked.
 *   - logSessionEvent(...) writes a JSONL line for every lifecycle step.
 *
 * Note: this module calls `lib/rpc-manager` directly in-process. The HTTP
 * `/api/agent/*` routes still exist for the browser UI — they wrap the
 * same primitives. We deliberately avoid HTTP self-calls here because the
 * listening port varies (dev=30141, prod=14514) and a hardcoded fallback
 * silently broke the channel when the two diverged.
 */
import { existsSync } from "fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { state, api } from "./index";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { logSessionEvent } from "./sessions-log";
import { createLogger } from "@/lib/logger";
import type { AgentEvent } from "@/lib/rpc-manager";

const log = createLogger("wechat/inbound");

/** A 5min safety net — even if the agent misbehaves we won't wait forever. */
const AGENT_END_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Per-account FIFO chain of in-flight handleInbound calls.
 *
 * The monitor loop fires `void handleInbound(...)` for every message in a
 * getUpdates batch, and those calls must be processed strictly in arrival
 * order. See the file-top docstring's "Concurrency" section for the two
 * specific races this prevents.
 *
 * A failure (rejection) in the previous call is caught here so the chain
 * doesn't poison itself — the impl reports errors to WeChat via safeReply,
 * so a rejection in this module would be a bug, not a user-facing condition.
 */
const inboundChains = new Map<string, Promise<unknown>>();

// Minimal local types — we only need to walk the well-known shape returned
// on agent_end. They are compatible with @earendil-works/pi-ai's
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

/**
 * Cold-start a fresh session in the current workspace, with all tools
 * enabled and the default model from settings.json (K1=c, K2=a).
 */
async function coldStart(workspaceId: string, firstMessage: string): Promise<string> {
  if (!existsSync(workspaceId)) {
    throw new Error(`Directory does not exist: ${workspaceId}`);
  }
  // One-time key so startRpcSession's lock doesn't conflict with real session ids.
  const tempKey = `__new__${Date.now()}`;
  const { session, realSessionId } = await startRpcSession(tempKey, "", workspaceId, "all");
  await session.send({ type: "prompt", message: firstMessage });
  return realSessionId;
}

/** Send a prompt to an existing session, starting it from disk if needed. */
async function sendPrompt(sessionId: string, message: string): Promise<void> {
  let session = getRpcSession(sessionId);
  if (!session?.isAlive()) {
    const filePath = await resolveSessionPath(sessionId);
    if (!filePath) throw new Error(`Session not found: ${sessionId}`);
    const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
    ({ session } = await startRpcSession(sessionId, filePath, cwd));
  }
  await session.send({ type: "prompt", message });
}

/**
 * Subscribe to the wrapper's event stream and wait for `agent_end`. Returns
 * the final assistant reply text by walking `event.messages` backwards and
 * joining the text content blocks of the last assistant message. This is the
 * stable path: pi guarantees the full `messages` snapshot on agent_end,
 * whereas the per-token `message_update` events vary in shape between
 * providers (Anthropic / OpenAI / Google all format `assistantMessageEvent`
 * differently).
 *
 * If `agent_end` carries an `error` field, or the last assistant message
 * has stopReason === "error" / "aborted", throws so the caller can surface
 * it to the user.
 */
async function waitForAgentReply(sessionId: string): Promise<string> {
  // The session should already be running (cold-start or sendPrompt
  // just kicked it). If for some reason it's gone, fail loudly rather
  // than silently waiting on a dead stream.
  const session = getRpcSession(sessionId);
  if (!session?.isAlive()) {
    throw new Error(`Session not running: ${sessionId}`);
  }

  return new Promise<string>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      unsubscribe();
      reject(new Error(`agent_end timed out after ${AGENT_END_TIMEOUT_MS}ms`));
    }, AGENT_END_TIMEOUT_MS);

    const unsubscribe = session.onEvent((event: AgentEvent) => {
      logSessionEvent({
        kind: "agent_event",
        sessionId,
        fromUserId: "",
        eventType: event.type,
      });
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
      const messages = Array.isArray(event.messages) ? (event.messages as AgentMessage[]) : null;
      if (!messages) {
        reject(new Error("agent_end arrived without messages"));
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
          .map((b) => b.text)
          .join("");
        if (text) {
          resolve(text);
          return;
        }
      }
      resolve("");
    });
  });
}

export interface InboundMessage {
  fromUserId: string;
  text: string;
  contextToken?: string;
}

/**
 * Main entry. Resolves once this call's reply has been sent to WeChat
 * (or attempts have been exhausted), after awaiting any earlier in-flight
 * call on the same account (see the file-top docstring's "Concurrency"
 * section).
 *
 * Never throws — all errors are logged and surfaced to the user via a
 * best-effort failure message, and the chain catches rejections so one
 * failed call doesn't poison the next.
 */
export async function handleInbound(msg: InboundMessage): Promise<void> {
  // Key by accountId so different accounts (in principle) don't block
  // each other. The impl re-reads loadAccount() because the account may
  // have changed (login/logout) by the time the chain actually runs.
  const account = state.loadAccount();
  const key = account?.accountId ?? "__no_account__";
  const prev = inboundChains.get(key) ?? Promise.resolve();
  // Catch on the previous promise so a rejection doesn't break the
  // chain. The impl itself shouldn't reject (it reports via safeReply),
  // but the .catch is belt-and-suspenders against an unexpected throw.
  const next = prev.catch(() => undefined).then(() => handleInboundImpl(msg));
  inboundChains.set(key, next);
  return next;
}

async function handleInboundImpl(msg: InboundMessage): Promise<void> {
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
