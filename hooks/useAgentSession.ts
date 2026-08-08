"use client";

import { useState, useCallback, useRef, useEffect, useReducer, useMemo } from "react";
import type { AgentMessage, SessionInfo, SessionTreeNode, AgentsFile, TextContent, UserMessage } from "@/lib/types";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ToolCallStatsDispatch } from "./ToolCallStatsContext";
import { useToast } from "@/components/Toast";
import { useI18n } from "./useI18n";
import { usePendingPermissionsRef } from "./usePendingPermissions";
import { setSessionUiState, setLeafChangeHandler } from "./sessionUiStore";

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  /** Fired once, when the first assistant message of a brand-new session has
   *  been persisted (pi lazily creates the .jsonl at that point). The sidebar
   *  uses this to refresh at the earliest moment the session is listable. */
  onFirstAssistantReady?: () => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  setNewSessionModel?: (model: { provider: string; modelId: string } | null) => void;
  setToolPreset?: (preset: "none" | "full") => void;
  /** Push tool lifecycle events to the stats panel */
  statsEmit?: ToolCallStatsDispatch;
  /** If set, navigate to this entry after the session finishes loading */
  scrollToEntryId?: string | null;
  /** Called after the scroll-to-entry navigation completes */
  onScrollComplete?: () => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  addImages: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  addImages: (files: File[]) => void;
}

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, onAgentEnd, onSessionCreated, onFirstAssistantReady,
    modelsRefreshKey, statsEmit,
    scrollToEntryId, onScrollComplete,
  } = opts;
  const { t } = useI18n();
  const toast = useToast();
  const permissionsRef = usePendingPermissionsRef();
  const statsEmitRef = useRef(statsEmit);
  statsEmitRef.current = statsEmit;

  // "New session" = no session selected yet. Deliberately not gated on
  // newSessionCwd: the very first entry lands on the new-session page before
  // any cwd is picked (AppShell pre-fills the most recent one), so isNew must
  // be true from the start or the welcome screen / model picker would never
  // render. handleSend guards its own creation path with `newSessionCwd`.
  const isNew = session === null;

  const [data, setData] = useState<SessionData | null>(null);
  // Only existing sessions load from disk — the new-session page (no session
  // yet, cwd possibly still being picked) must never sit in the loading
  // state, otherwise first entry would spin forever on "Loading session...".
  const [loading, setLoading] = useState(session !== null);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<{ id: string; name: string; provider: string }[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModelState] = useState<{ provider: string; modelId: string } | null>(null);
  const [toolPreset, setToolPreset] = useState<"none" | "full">(() => "full");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [agentsFiles, setAgentsFiles] = useState<AgentsFile[]>([]);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const agentRunningRef = useRef(false);
  // Holds the most recent assistant error message during a turn, so
  // agent_end can toast it. Cleared after the toast (or when the next
  // message_start arrives). auto_retry_end with success=false also
  // clears it to avoid double-toasting.
  const pendingAssistantErrorRef = useRef<string | null>(null);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  // Set when POST /api/agent/new returns for a brand-new session. Cleared on
  // the first assistant message_end — pi persists the .jsonl lazily at that
  // moment (openSync "wx" in SessionManager._persist), which is the earliest
  // point the session becomes listable by the sidebar.
  const pendingNewSessionFirstAssistantRef = useRef(false);
  const initialScrollDoneRef = useRef(false);
  const scrollToEntryIdRef = useRef(scrollToEntryId);
  scrollToEntryIdRef.current = scrollToEntryId;
  const onScrollCompleteRef = useRef(onScrollComplete);
  onScrollCompleteRef.current = onScrollComplete;
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Set by handleSend right before dispatch({type:"start"}). The auto-scroll
  // effect reads it on the next isStreaming false→true transition to tell
  // "user explicitly asked for a response" apart from "isStreaming just
  // flickered because the agent started a new assistant message after a tool
  // call". The former should re-engage sticky-bottom; the latter must not.
  const userJustSentRef = useRef(false);
  const loadingAgentsFilesRef = useRef<string | null>(null);

  const setNewSessionModel = opts.setNewSessionModel ?? setNewSessionModelState;
  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? newSessionModel : currentModel;

  // Input history for the chat input box. Backed by `messages` (which is
  // already populated from the backend .jsonl via loadSession, then kept
  // up to date by setMessages in handleSend + SSE events), so it always
  // reflects the actual conversation — no localStorage, no race conditions
  // around the isNew path's async sessionId. Older sessions may still hold
  // steer/follow-up entries written before those features were removed; their
  // display prefix is stripped so the recalled text is plain.
  const userMessageHistory = useMemo(() => {
    const out: string[] = [];
    for (const m of messages) {
      if (m.role !== "user") continue;
      const userMsg = m as UserMessage;
      let text: string;
      if (typeof userMsg.content === "string") {
        text = userMsg.content;
      } else {
        text = userMsg.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("");
      }
      text = text.replace(/^\[(?:steer|followup)\]\s+/, "");
      if (text.trim()) out.push(text);
    }
    return out.length > 100 ? out.slice(-100) : out;
  }, [messages]);
  const currentSessionId: string | null = data?.sessionId ?? sessionIdRef.current ?? null;

  const sessionStats = (() => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    return total > 0 ? { tokens, cost } : null;
  })();

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    try {
      if (showLoading) setLoading(true);
      const url = includeState
        ? `/api/sessions/${encodeURIComponent(sid)}?includeState`
        : `/api/sessions/${encodeURIComponent(sid)}`;
      const res = await fetch(url);
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData & { agentState?: { running: boolean; state?: { isStreaming?: boolean; contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null; systemPrompt?: string; thinkingLevel?: string } } };
      setData(d);
      setActiveLeafId(d.leafId);
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setCurrentModelOverride(null);
      setError(null);
      // If no live agent state, fall back to thinking level from session file
      if (!d.agentState?.state?.thinkingLevel && d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }
      return d.agentState ?? null;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    try {
      const url = leafId
        ? `/api/sessions/${encodeURIComponent(sid)}/context?leafId=${encodeURIComponent(leafId)}`
        : `/api/sessions/${encodeURIComponent(sid)}/context`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[] } };
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, []);

  const loadContextRef = useRef(loadContext);
  loadContextRef.current = loadContext;

  const loadTools = useCallback(async (sid: string) => {
    try {
      setToolPresetState("full");
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  const loadAgentsFiles = useCallback(async (cwd: string) => {
    if (loadingAgentsFilesRef.current === cwd) return;
    loadingAgentsFilesRef.current = cwd;
    try {
      const res = await fetch(`/api/context?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (loadingAgentsFilesRef.current !== cwd) return;
      const d = await res.json() as { files: AgentsFile[] };
      setAgentsFiles(d.files ?? []);
    } catch (e) {
      console.error("Failed to load agents files:", e);
      setAgentsFiles([]);
    } finally {
      if (loadingAgentsFilesRef.current === cwd) loadingAgentsFilesRef.current = null;
    }
  }, []);

  const connectEvents = useCallback((sid: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        handleAgentEventRef.current?.(event);
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      if (eventSourceRef.current === es && agentRunningRef.current) {
        es.close();
        eventSourceRef.current = null;
        setTimeout(() => {
          if (agentRunningRef.current) connectEvents(sid);
        }, 1000);
      }
    };
  }, []);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        statsEmitRef.current?.({ type: "reset" });
        break;
      case "agent_end":
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        // Surface the final assistant error (if any) after retries gave up
        // — auto_retry_end already toasts the same error on the success:false
        // path, so the ref is normally null here.
        if (pendingAssistantErrorRef.current) {
          toast.show({ kind: "error", message: pendingAssistantErrorRef.current });
          pendingAssistantErrorRef.current = null;
        }
        if (sessionIdRef.current) {
          loadSession(sessionIdRef.current);
          fetch(`/api/agent/${encodeURIComponent(sessionIdRef.current)}`)
            .then((r) => r.json())
            .then((d: { state?: { contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null; systemPrompt?: string } }) => {
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
            })
            .catch(() => {});
        }
        onAgentEnd?.();
        break;
      case "message_start":
      case "message_update": {
        const msg = event.message as Partial<AgentMessage> | undefined;
        // User messages are added optimistically by handleSend.
        // Skip SSE events for user messages to avoid double-display during streaming.
        if (msg && msg.role !== "user") {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        const completed = event.message as AgentMessage | undefined;
        // User messages are added optimistically by handleSend.
        // Skip appending from SSE to avoid duplication.
        if (completed && completed.role !== "user") {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        // First assistant message of a brand-new session → pi has lazily
        // persisted the .jsonl by now, so the sidebar can finally list it.
        if (completed?.role === "assistant" && pendingNewSessionFirstAssistantRef.current) {
          pendingNewSessionFirstAssistantRef.current = false;
          onFirstAssistantReady?.();
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        // Capture assistant errors for the upcoming agent_end toast. During
        // retries the SDK emits a fresh message_end per attempt; only the
        // last one wins, which is what we want for the final toast.
        if (completed?.role === "assistant" && completed.stopReason === "error") {
          pendingAssistantErrorRef.current = completed.errorMessage ?? "Model call failed";
        }
        // Refresh context usage after each assistant message so the progress
        // bar tracks every model API call, not just turn end.
        if (completed?.role === "assistant" && sessionIdRef.current) {
          fetch(`/api/agent/${encodeURIComponent(sessionIdRef.current)}`)
            .then((r) => r.json())
            .then((d: { state?: { contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null } }) => {
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
            })
            .catch(() => {});
        }
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        statsEmitRef.current?.({ type: "tool_start", toolCallId: id, toolName: name, timestamp: Date.now() });
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        statsEmitRef.current?.({ type: "tool_end", toolCallId: id, isError: false, timestamp: Date.now() });
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "prompt_failed": {
        // Emitted by rpc-manager when the inner prompt() rejects (missing
        // API key, unregistered model, etc.) before agent_start fires.
        // Reset local running state so the UI isn't stuck mid-turn.
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        const msg = event.error as string | undefined;
        toast.show({ kind: "error", message: msg || t("Failed to send message") });
        break;
      }
      case "auto_retry_end":
        setRetryInfo(null);
        // Exhausted retries (or non-retryable failure during a retry chain):
        // the SDK has already finalised the failure here, so toast the
        // finalError and clear the pending-error ref so agent_end doesn't
        // double-toast.
        if (event.success === false) {
          const finalError = event.finalError as string | undefined;
          if (finalError) {
            toast.show({ kind: "error", message: finalError });
            pendingAssistantErrorRef.current = null;
          }
        }
        break;
      case "permission_request": {
        const sid = sessionIdRef.current;
        if (!sid) break;
        permissionsRef.current?.addRequest({
          toolCallId: event.toolCallId as string,
          ruleName: event.ruleName as string,
          command: event.command as string,
          sessionId: sid,
        });
        break;
      }
      // Compaction is kernel-driven now (manual trigger was removed); keep
      // refreshing so the UI tracks the file after an auto-compaction, and
      // surface failures that used to show next to the compact button.
      case "compaction_end":
      case "auto_compaction_end":
        if (event.errorMessage) {
          toast.show({ kind: "error", message: event.errorMessage as string });
        } else if (!event.aborted) {
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
    }
  }, [loadSession, onAgentEnd, onFirstAssistantReady, permissionsRef, t, toast]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    if (!message.trim() && !images?.length) return;
    if (agentRunning) return;
    // New-session page with no cwd picked yet — can't create a session.
    if (isNew && !newSessionCwd) {
      toast.show({ kind: "error", message: t("Select a project first") });
      return;
    }

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setAgentRunning(true);
    setAgentPhase({ kind: "waiting_model" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    userJustSentRef.current = true;

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        if (selectedModel) setPendingModel(selectedModel);
        const { PRESET_NONE } = await import("@/components/ToolPanel");
        const toolNames = toolPreset === "none" ? PRESET_NONE : "all";
        const res = await fetch("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd: newSessionCwd,
            type: "prompt",
            message,
            toolNames,
            ...(piImages?.length ? { images: piImages } : {}),
            ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
            ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json() as { sessionId: string };
        const realId = result.sessionId;
        sessionIdRef.current = realId;
        connectEvents(realId);
        // Defer the sidebar refresh until the first assistant message lands:
        // the .jsonl does not exist before that, so a refresh right now would
        // not find the session.
        pendingNewSessionFirstAssistantRef.current = true;
        onSessionCreated?.({
          id: realId,
          path: "",
          cwd: newSessionCwd,
          name: undefined,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 1,
          firstMessage: message,
          running: false,
        });
      } else if (session) {
        connectEvents(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      toast.show({ kind: "error", message: e instanceof Error && e.message ? e.message : t("Failed to send message") });
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, toolPreset, thinkingLevel, session, agentRunning, connectEvents, onSessionCreated, t, toast]);

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
      toast.show({ kind: "error", message: e instanceof Error && e.message ? e.message : t("Failed to stop agent") });
    }
  }, [t, toast]);

  const handleNavigate = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
    } catch (e) {
      console.error("Failed to set model:", e);
      toast.show({ kind: "error", message: e instanceof Error && e.message ? e.message : t("Failed to switch model") });
    }
  }, [isNew, setNewSessionModel, t, toast]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
      toast.show({ kind: "error", message: e instanceof Error && e.message ? e.message : t("Failed to change thinking level") });
    }
  }, [t, toast]);

  const handleToolPresetChange = useCallback(async (preset: "none" | "full") => {
    const { PRESET_NONE } = await import("@/components/ToolPanel");
    const toolNames = preset === "none" ? PRESET_NONE : "all";
    setToolPresetState(preset);
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
      toast.show({ kind: "error", message: e instanceof Error && e.message ? e.message : t("Failed to change tool preset") });
    }
  }, [setToolPresetState, t, toast]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: elAbsTop - 16, behavior: "smooth" });
  }, []);

  // Load session + agents files on mount (parallel)
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      // Start both in parallel; agents files won't clobber if session.cwd changes mid-flight
      if (session.cwd) loadAgentsFiles(session.cwd);
      loadSession(session.id, true, true).then(async (agentState) => {
        if (agentState?.running) {
          loadTools(session.id);
          if (agentState.state?.isStreaming) {
            setAgentRunning(true);
            setAgentPhase({ kind: "waiting_model" });
            connectEvents(session.id);
          }
        }
        if (agentState?.state) {
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
        }

        // If a specific entry was requested via search, navigate to it
        const targetEntryId = scrollToEntryIdRef.current;
        if (targetEntryId) {
          setActiveLeafId(targetEntryId);
          await loadContextRef.current(session.id, targetEntryId);
          sendAgentCommand(session.id, { type: "navigate_tree", targetId: targetEntryId }).catch(() => {});
          // Scroll to the matched message after React commits the new messages
          setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
          }, 100);
          onScrollCompleteRef.current?.();
        }
      });
    } else if (newSessionCwd) {
      loadAgentsFiles(newSessionCwd);
    }
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setSessionUiState({ systemPrompt });
  }, [systemPrompt]);

  // Load agents files whenever cwd changes (session switch or new session)
  useEffect(() => {
    const cwd = session?.cwd ?? newSessionCwd;
    if (cwd) loadAgentsFiles(cwd);
    else setAgentsFiles([]);
  }, [session?.cwd, newSessionCwd, loadAgentsFiles]);

  useEffect(() => {
    setSessionUiState({ branchTree: data?.tree ?? [], branchActiveLeafId: activeLeafId });
  }, [data?.tree, activeLeafId]);

  // Keep the store's leaf-change handler ref pointing at the latest callback.
  // We don't include this in a useEffect (it would lag one render behind); a
  // direct call here means AppShell's BranchNavigator always calls the freshest
  // handler when the user clicks a branch.
  setLeafChangeHandler(handleLeafChange);

  useEffect(() => {
    if (messages.length > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      }
    }
  }, [messages.length, scrollToBottom, scrollUserMsgToTop]);

  // Load model list
  useEffect(() => {
    fetch("/api/models").then((r) => r.json()).then((d: { models: Record<string, string>; modelList?: { id: string; name: string; provider: string }[]; defaultModel?: { provider: string; modelId: string } | null; thinkingLevels?: Record<string, string[]>; thinkingLevelMaps?: Record<string, Record<string, string | null>> }) => {
      setModelNames(d.models);
      if (d.thinkingLevels) setModelThinkingLevels(d.thinkingLevels);
      if (d.thinkingLevelMaps) setModelThinkingLevelMaps(d.thinkingLevelMaps);
      if (d.modelList) {
        setModelList(d.modelList);
        if (isNew && d.modelList.length > 0) {
          const def = d.defaultModel;
          const match = def && d.modelList.find((m) => m.id === def.modelId && m.provider === def.provider);
          const selected = match
            ? { provider: match.provider, modelId: match.id }
            : { provider: d.modelList[0].provider, modelId: d.modelList[0].id };
          setNewSessionModel(selected);
        }
      }
    }).catch(() => {});
  }, [isNew, modelsRefreshKey, setNewSessionModel]);

  // Publish the remaining session-level state to the store. The shallow-equal
  // guard inside setSessionUiState prevents re-rendering AppShell's top bar
  // when an IIFE-derived value (sessionStats) gets a new object identity but
  // the same scalar contents.
  useEffect(() => { setSessionUiState({ sessionStats }); }, [sessionStats]);
  useEffect(() => { setSessionUiState({ contextUsage }); }, [contextUsage]);
  useEffect(() => { setSessionUiState({ agentsFiles }); }, [agentsFiles]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, contextUsage, systemPrompt,
    currentModel, displayModel, sessionStats,
    agentPhase,
    isNew,
    agentsFiles,
    currentSessionId,
    userMessageHistory,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef, userJustSentRef,
    // Actions
    handleSend, handleAbort, handleNavigate, handleModelChange,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadAgentsFiles, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning,
    // Subscriptions
    handleAgentEventRef,
  };
}
