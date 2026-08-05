"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  SessionInfo,
  ToolCallContent,
  ToolResultMessage,
} from "@/lib/types";
import {
  countToolCallsByName,
  getAssistantErrorMessage,
  splitFinalAssistantBlocks,
} from "@/lib/message-display";
import { AGENT_TODO_TOOL_NAME } from "@/lib/agent-todo-tool-types";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { Tooltip } from "./Tooltip";
import { AgentTodoPanel } from "./AgentTodoPanel";
import { ReplayBar } from "./ReplayBar";
import { useAgentSession, type AgentPhase } from "@/hooks/useAgentSession";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "@/components/Toast";
import type { SlashResource } from "./ChatInput";
import { ToolCallStatsProvider, useToolCallStatsEmit } from "@/hooks/ToolCallStatsContext";
import { useToolCallStats } from "@/hooks/useToolCallStats";
import { useCollapseHeight } from "@/hooks/useCollapseHeight";
import { setToolCallStatsScrollCallback, setToolCallStatsState } from "@/hooks/toolCallStatsStore";
import { setAgentControls } from "@/hooks/sessionUiStore";
import { SessionSearch } from "./SessionSearch";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  /** If set, navigate to this entry after the session finishes loading */
  scrollToEntryId?: string | null;
  /** Called after the scroll-to-entry navigation completes */
  onScrollComplete?: () => void;
  onNewSessionRequest?: () => void;
  /** Fired after the auto-name PATCH succeeds — used to refresh the sidebar. */
  onRenameCompleted?: () => void;
  /** Fired as soon as the user confirms a rename — keeps in-memory state in sync. */
  onSessionNameChange?: (name: string) => void;
}

function phaseLabel(phase: AgentPhase, t: ReturnType<typeof useI18n>["t"]): string {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("Running tool...");
    if (names.length === 1) return `${t("Running")} ${names[0]}...`;
    if (names.length <= 3) return `${t("Running")} ${names.join(", ")}...`;
    return `${t("Running")} ${names.slice(0, 2).join(", ")} (+${names.length - 2})...`;
  }
  if (phase?.kind === "waiting_model") return t("Waiting for model...");
  return t("Thinking...");
}

// ── Per-turn process folding ──
//
// A "turn" runs from one anchor (user message or compaction summary) up to
// the next anchor. The non-final assistant messages in a turn — thinking,
// tool calls, intermediate text — are wrapped in a ProcessDetailsGroup so
// users can collapse them and focus on the final answer.
//
// While the agent is still running on the current turn (agentRunning is true
// and the anchor is the last user message), the process is rendered inline
// instead. Folding only kicks in once the whole turn finishes, so users see
// the full think → tool-call → intermediate text flow as it streams and then
// get a single collapsed summary at the end. Active streaming content for
// the in-progress message still lives in streamState.streamingMessage and is
// rendered separately below.

function isGroupAnchor(msg: AgentMessage): boolean {
  if (msg.role === "user") return true;
  // session-reader.ts synthesises a "compactionSummary" message at the start
  // of a post-compaction turn. Treat it as a turn anchor so the pre-compaction
  // process history stays attached to its own turn.
  return (msg as { role?: string }).role === "compactionSummary";
}

function hasFinalAssistantAnswer(msg: AgentMessage): boolean {
  if (msg.role !== "assistant") return false;
  return splitFinalAssistantBlocks(msg).answerBlocks.some(
    (b) => b.type === "image" || (b.type === "text" && b.text.trim().length > 0),
  );
}

/** Find the final assistant message in [userIdx+1, endIdx). Prefers messages
 *  with a non-empty trailing answer; falls back to the last assistant message.
 *  Returns -1 when no assistant message exists in the range. */
function findFinalAssistantIndex(
  messages: AgentMessage[],
  userIdx: number,
  endIdx: number,
): number {
  for (let i = endIdx - 1; i > userIdx; i--) {
    if (hasFinalAssistantAnswer(messages[i])) return i;
  }
  for (let i = endIdx - 1; i > userIdx; i--) {
    if (messages[i]?.role === "assistant") return i;
  }
  return -1;
}

/** A message contributes to the process group if it has thinking/tool content
 *  worth collapsing. Empty assistant messages and pure-text replies stay out. */
function hasDisplayableProcessMessage(msg: AgentMessage): boolean {
  if (msg.role !== "assistant") return false;
  const blocks = msg.content ?? [];
  return blocks.some((b) => b.type === "thinking" || b.type === "toolCall");
}

/** Clone an assistant message with a different content array. */
function withAssistantBlocks(
  message: AssistantMessage,
  blocks: AssistantContentBlock[],
): AssistantMessage {
  return { ...message, content: blocks };
}

/** How many tool names the process summary lists before falling back to "+N". */
const MAX_TOOL_BREAKDOWN = 3;

function ProcessDetailsGroup({
  messageCount,
  toolCallCounts,
  children,
}: {
  messageCount: number;
  toolCallCounts: Record<string, number>;
  children: React.ReactNode;
}) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  // Height animation for expand/collapse — same pattern as the thinking block:
  // container height follows the rendered content via ResizeObserver.
  const { contentRef, contentHeight, allowAnim } = useCollapseHeight<HTMLDivElement>();

  const toolCallCount = Object.values(toolCallCounts).reduce((s, n) => s + n, 0);
  const summary = t("{n} messages").replace("{n}", String(messageCount));
  const withCalls =
    toolCallCount > 0
      ? ` · ${t(toolCallCount === 1 ? "{n} tool call" : "{n} tool calls").replace("{n}", String(toolCallCount))}`
      : "";
  // Per-tool breakdown: top tool names by call count (e.g. "· 3× bash、2× read").
  // Only the top few fit in the single-line summary; when more tools were
  // used, hovering the summary shows the full breakdown via Tooltip.
  const toolEntries = Object.entries(toolCallCounts).sort((a, b) => b[1] - a[1]);
  const toolSummary = (() => {
    if (toolEntries.length === 0) return null;
    const sep = locale === "zh" ? "、" : ", ";
    const shown = toolEntries
      .slice(0, MAX_TOOL_BREAKDOWN)
      .map(([name, n]) => t("{n}× {tool}").replace("{n}", String(n)).replace("{tool}", name))
      .join(sep);
    const rest = toolEntries.length - Math.min(toolEntries.length, MAX_TOOL_BREAKDOWN);
    return ` · ${shown}${rest > 0 ? ` ${t("+{n}").replace("{n}", String(rest))}` : ""}`;
  })();
  const toolFullList =
    toolEntries.length > MAX_TOOL_BREAKDOWN
      ? toolEntries
          .map(([name, n]) => t("{n}× {tool}").replace("{n}", String(n)).replace("{tool}", name))
          .join(locale === "zh" ? "、" : ", ")
      : null;

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="process-summary"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 0.15s",
          }}
        >
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summary}
          {withCalls}
          {toolSummary && (toolFullList ? (
            <Tooltip content={toolFullList}>
              <span>{toolSummary}</span>
            </Tooltip>
          ) : (
            toolSummary
          ))}
        </span>
      </button>
      <div
        style={{
          height: contentHeight ?? "auto",
          overflow: "hidden",
          transition: allowAnim ? "height 0.3s cubic-bezier(0.4, 0, 0.2, 1)" : "none",
        }}
      >
        <div ref={contentRef} style={{ overflow: "hidden" }}>
          {expanded && <div style={{ marginTop: 8 }}>{children}</div>}
        </div>
      </div>
    </div>
  );
}

function ChatWindowContent({ session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, scrollToEntryId, onScrollComplete, onNewSessionRequest, onRenameCompleted, onSessionNameChange }: Props) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [slashResources, setSlashResources] = useState<SlashResource[]>([]);
  const [isExporting, setIsExporting] = useState(false);

  // Tool call stats: wire the context emit into useAgentSession
  const statsEmit = useToolCallStatsEmit();

  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, forkingEntryId, contextUsage,
    isCompacting, compactError, displayModel: displayModelValue,
    agentPhase,
    isNew,
    messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handleAbortCompaction,
    handleToolPresetChange, handleThinkingLevelChange,
    activeLeafId, currentSessionId,
  } = useAgentSession({
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey,
    statsEmit,
    scrollToEntryId,
    onScrollComplete,
  });

  // Tool call stats hook — snapshot is published to the module store so the
  // right-panel tab + vertical button (in AppShell) can render it.
  const { snapshot } = useToolCallStats(messages);

  // First user message text — used to gate the auto-name button. The server
  // route reads the same field from the .jsonl, so this is purely a UI
  // enable/disable hint and never authoritative.
  const firstUserMessageText = useMemo(() => {
    const first = messages.find((m) => m.role === "user");
    if (!first) return null;
    const content = (first as { content: unknown }).content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      return trimmed || null;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          const text = (block as { text: string }).text.trim();
          if (text) return text;
        }
      }
    }
    return null;
  }, [messages]);

  // ── Register agent controls with the palette store ──
  // The ⌘K command palette in AppShell reads these via useAgentControls().
  // Each entry is a stable callback owned by useAgentSession — including
  // them in the dep list would churn the ref every render, so we register
  // once on mount and update isStreaming/isCompacting imperatively.
  useEffect(() => {
    setAgentControls({
      switchModel: handleModelChange,
      switchThinkingLevel: handleThinkingLevelChange,
      switchToolPreset: handleToolPresetChange,
      compact: handleCompact,
      abortStreaming: handleAbort,
      abortCompaction: handleAbortCompaction,
      isStreaming: agentRunning,
      isCompacting,
    });
    return () => setAgentControls(null);
    // Handlers come from useAgentSession (stable useCallback refs); only
    // re-register when the bits that drive `when()` predicates change.
  }, [agentRunning, isCompacting]); // eslint-disable-line react-hooks/exhaustive-deps

  // Export the current session as a single-file HTML download. Mirrors the
  // fetch → blob → object-URL → <a download> pattern in hooks/useTodos.tsx
  // (which exports a todo as a zip).
  const handleExport = useCallback(async () => {
    if (!currentSessionId || isExporting) return;
    setIsExporting(true);
    try {
      const params = new URLSearchParams();
      if (activeLeafId) params.set("leafId", activeLeafId);
      if (locale) params.set("locale", locale);
      const qs = params.toString();
      const url = `/api/sessions/${encodeURIComponent(currentSessionId)}/export${qs ? `?${qs}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(error || `status ${res.status}`);
      }
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") ?? "";
      let filename = `session-${currentSessionId.slice(0, 8)}.html`;
      const mStar = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      if (mStar) {
        try { filename = decodeURIComponent(mStar[1]); } catch { /* keep fallback */ }
      } else {
        const mPlain = /filename="?([^";]+)"?/i.exec(cd);
        if (mPlain) filename = mPlain[1];
      }
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      toast.show({ kind: "success", message: t("Exported") });
    } catch (error) {
      toast.show({
        kind: "error",
        message: `${t("Export failed")}: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setIsExporting(false);
    }
  }, [currentSessionId, activeLeafId, locale, isExporting, t, toast]);

  // Running summary for the vertical toolbar badge
  const runningSummary = agentPhase?.kind === "running_tools" && agentPhase.tools.length > 0
    ? t("{n} running · {m} total").replace("{n}", String(agentPhase.tools.length)).replace("{m}", String(snapshot.totalCount))
    : snapshot.totalCount > 0
      ? t("{n} total").replace("{n}", String(snapshot.totalCount))
      : undefined;

  // Publish the latest stats snapshot + summary to the module store so
  // AppShell's right-panel tab + vertical button can render them without
  // owning the reducer state themselves.
  useEffect(() => {
    setToolCallStatsState({ snapshot, runningSummary });
  }, [snapshot, runningSummary]);

  // ── Scroll-to-bottom: auto-track during streaming, pause on user scroll-up ──
  const [showToBottom, setShowToBottom] = useState(false);
  const userScrolledUpRef = useRef(false);
  const isProgrammaticScrollRef = useRef(false);

  // ── In-session search state ──
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchKeywords, setSearchKeywords] = useState<string[]>([]);
  const [matchedEntryIds, setMatchedEntryIds] = useState<Set<string>>(new Set());
  const [highlightEntryId, setHighlightEntryId] = useState<string | null>(null);
  const [pendingJumpEntryId, setPendingJumpEntryId] = useState<string | null>(null);

  // ── Replay ("time travel"): message-level scrubber. All state is local so it
  // resets on session switch (ChatWindow remounts via key={sessionKey}). ──
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const handleReplayIndexChange = useCallback((n: number) => setReplayIndex(n), []);
  const handleReplayPlayingChange = useCallback((p: boolean) => setReplayPlaying(p), []);
  const handleReplaySpeedChange = useCallback((s: number) => setReplaySpeed(s), []);
  const closeReplay = useCallback(() => {
    setReplayOpen(false);
    setReplayPlaying(false);
  }, []);

  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = dist < 100;
    userScrolledUpRef.current = !nearBottom;
    setShowToBottom(!nearBottom);
  }, []);

  const handleToBottom = useCallback(() => {
    userScrolledUpRef.current = false;
    setShowToBottom(false);
    isProgrammaticScrollRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setTimeout(() => { isProgrammaticScrollRef.current = false; }, 500);
  }, [messagesEndRef]);

  // ── In-session search: Ctrl+F toggle ──
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f" && session) {
        e.preventDefault();
        setSearchVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [session]);

  // ── In-session search: close on session change ──
  useEffect(() => {
    setSearchVisible(false);
    setSearchKeywords([]);
    setMatchedEntryIds(new Set());
    setHighlightEntryId(null);
    setPendingJumpEntryId(null);
    setReplayOpen(false);
    setReplayPlaying(false);
  }, [session?.id]);

  // ── Replay: force-close when the agent starts running (replay and a live
  // stream must not coexist — the truncated view would fight the SSE tail). ──
  useEffect(() => {
    if (streamState.isStreaming || agentRunning) {
      setReplayOpen(false);
      setReplayPlaying(false);
    }
  }, [streamState.isStreaming, agentRunning]);

  // ── In-session search: results change callback ──
  const handleSearchResultsChange = useCallback((ids: string[], keyword: string) => {
    setMatchedEntryIds(new Set(ids));
    setSearchKeywords(keyword ? [keyword] : []);
    if (!keyword) setHighlightEntryId(null);
  }, []);

  // ── In-session search: jump to a message ──
  const handleSearchJumpTo = useCallback((entryId: string, leafId: string) => {
    // Navigate to the branch containing this message
    handleNavigate(leafId);
    setPendingJumpEntryId(entryId);
  }, [handleNavigate]);

  // ── In-session search: close callback ──
  const handleSearchClose = useCallback(() => {
    setSearchVisible(false);
    setSearchKeywords([]);
    setMatchedEntryIds(new Set());
    setHighlightEntryId(null);
  }, []);

  // ── In-session search: scroll to entry after branch switch ──
  useEffect(() => {
    if (!pendingJumpEntryId) return;
    const idx = entryIds.indexOf(pendingJumpEntryId);
    if (idx === -1) return;

    // Compute visible message index
    let visibleIdx = 0;
    for (let i = 0; i < idx; i++) {
      const m = messages[i];
      if (m && (m.role === "user" || m.role === "assistant")) visibleIdx++;
    }

    const el = messageRefs.current[visibleIdx];
    const container = scrollContainerRef.current;
    if (el && container) {
      userScrolledUpRef.current = false;
      setShowToBottom(false);
      const elTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo({ top: elTop - 20, behavior: "smooth" });
    }

    setHighlightEntryId(pendingJumpEntryId);
    setPendingJumpEntryId(null);

    // Flash highlight off after 2s
    const timer = setTimeout(() => setHighlightEntryId(null), 2000);
    return () => clearTimeout(timer);
  }, [pendingJumpEntryId, entryIds, messages]);

  // ── Auto-scroll to bottom during streaming ──
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    // Streaming just started → reset scroll tracking
    if (streamState.isStreaming && !prevStreamingRef.current) {
      userScrolledUpRef.current = false;
      setShowToBottom(false);
    }
    prevStreamingRef.current = streamState.isStreaming;

    // Auto-scroll on every streaming update (unless user paused)
    if (streamState.isStreaming && !userScrolledUpRef.current) {
      isProgrammaticScrollRef.current = true;
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
      setTimeout(() => { isProgrammaticScrollRef.current = false; }, 150);
    }
  }, [streamState.streamingMessage, streamState.isStreaming]);

  // ── Auto-scroll to the truncation point as replay advances ──
  useEffect(() => {
    if (!replayOpen) return;
    if (userScrolledUpRef.current) return;
    isProgrammaticScrollRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    const timer = setTimeout(() => { isProgrammaticScrollRef.current = false; }, 200);
    return () => clearTimeout(timer);
  }, [replayIndex, replayOpen, messagesEndRef]);

  const onDrop = useCallback((files: File[]) => {
    chatInputRef?.current?.addImages(files);
  }, [chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const messageRefs = useRef<(HTMLDivElement | null)[]>([]);
  messageRefs.current = Array(visibleMessages.length)
    .fill(null)
    .map((_, i) => messageRefs.current[i] ?? null);

  // Replay is only active for a settled (non-streaming) session. When active,
  // the chat renders only messages[0..replayIndex]; toolResultsMap is still
  // built from the FULL messages so a tool call still pairs with its result
  // even when the result sits past the cutoff.
  const replayActive = replayOpen && !streamState.isStreaming && !agentRunning;
  const renderMessages = replayActive ? messages.slice(0, replayIndex) : messages;
  const renderEntryIds = replayActive ? entryIds.slice(0, replayIndex) : entryIds;
  const replayLabel = (() => {
    const base = `${replayIndex} / ${messages.length}`;
    const m = messages[replayIndex - 1] as (AgentMessage & { timestamp?: number }) | undefined;
    if (m?.timestamp) return `${base} · ${new Date(m.timestamp).toLocaleTimeString()}`;
    return base;
  })();
  const openReplay = useCallback(() => {
    setReplayIndex(messages.length);
    setReplayPlaying(false);
    setReplayOpen(true);
  }, [messages.length]);

  // Map agent_todo task id → toolCallId of the most recent "mark completed"
  // call. Used by AgentTodoPanel to scroll-to on click. Rebuilt from messages
  // (which the agent-todo audit log is a strict subset of), so no extra
  // server-side bookkeeping is needed — see approach discussion in chat.
  const taskIdToCompletedToolCallId = useMemo(() => {
    const map: Record<number, string> = {};
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const blocks = (msg as AssistantMessage).content ?? [];
      for (const block of blocks) {
        if (block.type !== "toolCall") continue;
        const tc = block as ToolCallContent;
        if (tc.toolName !== AGENT_TODO_TOOL_NAME) continue;
        const input = tc.input as Record<string, unknown> | undefined;
        if (!input || input.action !== "update" || input.status !== "completed") continue;
        const id = input.id;
        if (typeof id !== "number") continue;
        // Last wins — handles a re-completed task without losing the latest.
        map[id] = tc.toolCallId;
      }
    }
    return map;
  }, [messages]);

  // Map every visible tool call's toolCallId to its visible message index.
  // Used by handleScrollToToolCall; rebuilt when messages change so newly
  // streamed tool calls become jumpable without delay.
  const toolCallToVisibleIdx = useMemo(() => {
    const map = new Map<string, number>();
    let vi = 0;
    for (const msg of messages) {
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      if (msg.role === "assistant") {
        for (const block of (msg as AssistantMessage).content ?? []) {
          if (block.type === "toolCall") {
            map.set((block as ToolCallContent).toolCallId, vi);
          }
        }
      }
      vi++;
    }
    return map;
  }, [messages]);

  // Scroll a tool call into view by its toolCallId. Shared between the stats
  // drawer (click on a tool name) and the agent-todo panel (click on a
  // completed task that maps back to a toolCallId).
  const handleScrollToToolCall = useCallback((toolCallId: string) => {
    const idx = toolCallToVisibleIdx.get(toolCallId);
    if (idx === undefined) return;
    const el = messageRefs.current[idx];
    const container = scrollContainerRef.current;
    if (el && container) {
      userScrolledUpRef.current = false;
      setShowToBottom(false);
      const elTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo({ top: elTop - 20, behavior: "smooth" });
    }
  }, [toolCallToVisibleIdx, messageRefs, scrollContainerRef]);

  // Register the scroll callback with the module store so the right-panel tab
  // body can jump to a tool-call message when the user clicks a row. Clear on
  // unmount so a stale callback can't be invoked from a different session.
  useEffect(() => {
    setToolCallStatsScrollCallback(handleScrollToToolCall);
    return () => setToolCallStatsScrollCallback(null);
  }, [handleScrollToToolCall]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !agentRunning;

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const sessionId = session?.id;
  const slashResourceKey = sessionId ?? (newSessionCwd ? `new:${newSessionCwd}` : "none");

  useEffect(() => {
    const controller = new AbortController();
    const params = sessionId
      ? `sessionId=${encodeURIComponent(sessionId)}`
      : newSessionCwd ? `cwd=${encodeURIComponent(newSessionCwd)}` : "";

    if (!params) {
      setSlashResources([]);
      return;
    }

    fetch(`/api/slash-commands?${params}`, { signal: controller.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: { commands?: SlashResource[] }) => setSlashResources(d.commands ?? []))
      .catch((e) => {
        if ((e as { name?: string }).name !== "AbortError") {
          console.error("Failed to load slash commands:", e);
        }
        setSlashResources([]);
      });

    return () => controller.abort();
  }, [sessionId, newSessionCwd]);

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      isStreaming={agentRunning}
      model={displayModelValue}
      modelNames={modelNames}
      modelList={modelList}
      onModelChange={handleModelChange}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      contextUsage={contextUsage}
      slashResources={slashResources}
      slashResourceKey={slashResourceKey}
      onSlashAction={(action) => { if (action === "new") onNewSessionRequest?.(); }}
      onNewSession={onNewSessionRequest}
      onOpenReplay={openReplay}
      replayAvailable={!streamState.isStreaming && !agentRunning && messages.length > 0}
      onExport={session ? handleExport : undefined}
      isExporting={isExporting}
      sessionId={currentSessionId}
      firstUserMessageText={firstUserMessageText}
      currentSessionName={session?.name ?? null}
      onRenameCompleted={onRenameCompleted ?? (() => {})}
      onSessionNameChange={onSessionNameChange}
    />
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        {t("Loading session...")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {isEmptyNew ? (
        <>
          <div className="flex flex-1 items-end justify-center overflow-hidden px-4">
            <div
              className="mb-3 w-full max-w-[820px]"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                paddingLeft: 16,
                paddingRight: 16,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, flex: 1, lineHeight: 1.4 }}>
                <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, letterSpacing: "-0.01em" }}>Pi Work</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  pi <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
                </span>
              </div>
            </div>
          </div>
          <div className="relative">{chatInputElement}</div>
        </>
      ) : (
      <>
      {replayActive && (
        <ReplayBar
          total={messages.length}
          index={replayIndex}
          playing={replayPlaying}
          speed={replaySpeed}
          positionLabel={replayLabel}
          onIndexChange={handleReplayIndexChange}
          onPlayingChange={handleReplayPlayingChange}
          onSpeedChange={handleReplaySpeedChange}
          onClose={closeReplay}
        />
      )}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Agent Todo: absolute-positioned floating panel in the chat area's
            left whitespace. Lives as a sibling of the scroll container (not
            a flex item) so it does not squeeze the centered message column. */}
        <AgentTodoPanel
          sessionId={session?.id ?? null}
          taskToolCallIds={taskIdToCompletedToolCallId}
          onJumpToTask={handleScrollToToolCall}
        />
        <div ref={scrollContainerRef} onScroll={handleScroll} className="relative flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto max-w-[820px]">

            {(() => {
              const toolResultsMap = new Map<string, ToolResultMessage>();
              for (const msg of messages) {
                if (msg.role === "toolResult") {
                  toolResultsMap.set(msg.toolCallId, msg);
                }
              }
              let lastUserIdx = -1;
              for (let i = renderMessages.length - 1; i >= 0; i--) {
                if (renderMessages[i].role === "user") { lastUserIdx = i; break; }
              }
              let refIdx = 0;

              // Render one message at idx. Optional messageOverride renders a
              // clone (used for the process/answer split of the final assistant).
              // attachRef:false skips the wrapper div + ref — used when the same
              // idx is rendered twice (process clone vs answer clone) so only one
              // ref slot is consumed, and for orphan tool-result clones that
              // wouldn't be visible anyway.
              const renderOne = (
                idx: number,
                opts: {
                  messageOverride?: AgentMessage;
                  attachRef?: boolean;
                  showTimestamp?: boolean;
                  keySuffix?: string;
                } = {},
              ): React.ReactNode => {
                const msg = opts.messageOverride ?? renderMessages[idx];
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && renderMessages[idx - 1].role === "assistant"
                    ? renderEntryIds[idx - 1]
                    : undefined;
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = isVisible && opts.attachRef !== false ? refIdx++ : -1;
                let showTimestamp = opts.showTimestamp ?? false;
                if (opts.showTimestamp === undefined) {
                  showTimestamp = false;
                  if (msg.role === "assistant") {
                    showTimestamp = true;
                    for (let j = idx + 1; j < renderMessages.length; j++) {
                      const r = renderMessages[j].role;
                      if (r === "user") break;
                      if (r === "assistant") { showTimestamp = false; break; }
                    }
                    // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                    if (showTimestamp && streamState.isStreaming && idx === renderMessages.length - 1) {
                      showTimestamp = false;
                    }
                  }
                }
                const key = `${idx}-${opts.keySuffix ?? ""}`;
                const view = (
                  <MessageView
                    key={key}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    entryId={renderEntryIds[idx]}
                    onFork={agentRunning || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
                    forking={forkingEntryId === renderEntryIds[idx]}
                    onNavigate={agentRunning ? undefined : handleNavigate}
                    prevAssistantEntryId={agentRunning ? undefined : prevAssistantEntryId}
                    onEditContent={(content) => chatInputRef?.current?.insertIfEmpty(content)}
                    showTimestamp={showTimestamp}
                    keywords={searchKeywords}
                    highlightEntryId={highlightEntryId}
                    isSearchMatch={matchedEntryIds.has(renderEntryIds[idx])}
                    cwd={session?.cwd}
                    sessionId={session?.id}
                  />
                );
                if (currentRefIdx === -1) return view;
                return (
                  <div key={key} ref={(el) => {
                    messageRefs.current[currentRefIdx] = el;
                    if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
                  }}>
                    {view}
                  </div>
                );
              };

              // Group consecutive non-anchor messages into a foldable process
              // group. Each turn runs from an anchor (user / compactionSummary)
              // to the next anchor; intermediate assistant messages + the
              // process portion of the final assistant are collapsed by default.
              const rendered: React.ReactNode[] = [];
              for (let idx = 0; idx < renderMessages.length;) {
                const msg = renderMessages[idx];
                if (!isGroupAnchor(msg)) {
                  rendered.push(renderOne(idx));
                  idx += 1;
                  continue;
                }

                const userIdx = idx;
                let endIdx = userIdx + 1;
                while (endIdx < renderMessages.length && !isGroupAnchor(renderMessages[endIdx])) {
                  endIdx += 1;
                }

                const finalAssistantIdx = findFinalAssistantIndex(renderMessages, userIdx, endIdx);
                if (finalAssistantIdx === -1) {
                  for (let i = userIdx; i < endIdx; i++) rendered.push(renderOne(i));
                  idx = endIdx;
                  continue;
                }

                // Anchor message (user / compactionSummary)
                rendered.push(renderOne(userIdx));

                // Intermediate assistant messages in the turn
                const processIndices: number[] = [];
                for (let i = userIdx + 1; i < finalAssistantIdx; i++) processIndices.push(i);

                // Split the final assistant: everything before the last
                // text/image is "process", the trailing text/image is "answer".
                const finalAssistant = renderMessages[finalAssistantIdx] as AssistantMessage;
                const split = splitFinalAssistantBlocks(finalAssistant);
                const finalProcessMessage = split.processBlocks.length > 0
                  ? withAssistantBlocks(finalAssistant, split.processBlocks)
                  : null;
                const finalAnswerMessage =
                  split.answerBlocks.length > 0 || getAssistantErrorMessage(finalAssistant)
                    ? withAssistantBlocks(finalAssistant, split.answerBlocks)
                    : null;

                const visibleProcessIndices = processIndices.filter((i) =>
                  hasDisplayableProcessMessage(renderMessages[i]),
                );
                const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);

                // While the agent is still running on this turn, render the
                // process inline instead of folding it. Folding only kicks in
                // once the turn is complete (agentRunning flips back to false)
                // so users see the full think → tool-call → intermediate text
                // flow as it streams, then get a single collapsed summary at
                // the end. Without this, each message_end would re-mount the
                // fold group with a new key and snap it shut on every step.
                const isCurrentTurnInProgress =
                  agentRunning && userIdx === lastUserIdx && lastUserIdx !== -1;

                const processChildren = (
                  <Fragment>
                    {visibleProcessIndices.map((i) => renderOne(i, { keySuffix: "process" }))}
                    {finalProcessMessage &&
                      renderOne(finalAssistantIdx, {
                        messageOverride: finalProcessMessage,
                        attachRef: false,
                        keySuffix: "process-final",
                        showTimestamp: false,
                      })}
                  </Fragment>
                );

                if (processCount > 0) {
                  if (isCurrentTurnInProgress) {
                    rendered.push(<Fragment key={`process-${userIdx}`}>{processChildren}</Fragment>);
                  } else {
                    rendered.push(
                      <ProcessDetailsGroup
                        key={`process-${userIdx}`}
                        messageCount={processCount}
                        toolCallCounts={countToolCallsByName(renderMessages, visibleProcessIndices, split.processBlocks)}
                      >
                        {processChildren}
                      </ProcessDetailsGroup>,
                    );
                  }
                }

                if (finalAnswerMessage) {
                  rendered.push(
                    renderOne(finalAssistantIdx, {
                      messageOverride: finalAnswerMessage,
                      keySuffix: "answer",
                    }),
                  );
                }

                idx = endIdx;
              }
              return rendered;
            })()}

            {streamState.isStreaming && streamState.streamingMessage && (
              <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelNames} cwd={session?.cwd} sessionId={session?.id} />
            )}

            {agentRunning && !streamState.streamingMessage && (
              <div className="py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
              </div>
            )}

            {agentRunning && !streamState.streamingMessage && (
              <div style={{ height: 120 }} />
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* To-bottom button — shown when user scrolls up */}
        {showToBottom && (
          <Tooltip content={t("Scroll to bottom")}>
          <button
            onClick={handleToBottom}
            className="absolute bottom-4 right-12 z-10 flex h-9 w-9 items-center justify-center rounded-full border shadow-lg transition-all duration-200 hover:scale-110"
            style={{
              background: "var(--bg-panel)",
              borderColor: "var(--border)",
              color: "var(--text-muted)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          </Tooltip>
        )}

        {/* Replay toggle now lives next to the input box (ChatInput bottom
            buttons) — opens the time-travel scrubber. Hidden while the agent
            is running (replay must not coexist with a live stream). */}

        {/* Tool call stats are rendered as a right-panel tab by AppShell.
            We just publish the snapshot + scroll callback to the module store. */}
      </div>

      <div className="relative">
        {session && (
          <SessionSearch
            sessionId={session.id}
            visible={searchVisible}
            onJumpTo={handleSearchJumpTo}
            onResultsChange={handleSearchResultsChange}
            onClose={handleSearchClose}
          />
        )}
        {chatInputElement}
      </div>
      </>
      )}
    </div>
  );
}

export function ChatWindow(props: Props) {
  return (
    <ToolCallStatsProvider>
      <ChatWindowContent {...props} />
    </ToolCallStatsProvider>
  );
}
