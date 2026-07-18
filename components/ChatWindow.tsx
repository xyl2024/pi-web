"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, AssistantMessage, SessionInfo, ToolCallContent } from "@/lib/types";
import { AGENT_TODO_TOOL_NAME } from "@/lib/agent-todo-tool-types";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { Tooltip } from "./Tooltip";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { AgentTodoPanel } from "./AgentTodoPanel";
import { ReplayBar } from "./ReplayBar";
import { useAgentSession, type AgentPhase } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "@/components/Toast";
import type { SlashResource } from "./ChatInput";
import { ToolCallStatsProvider, useToolCallStatsEmit } from "@/hooks/ToolCallStatsContext";
import { useToolCallStats } from "@/hooks/useToolCallStats";
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

function ChatWindowContent({ session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, scrollToEntryId, onScrollComplete, onNewSessionRequest }: Props) {
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
    handleToolPresetChange, handleThinkingLevelChange, handleAgentEventRef,
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

  const { soundEnabled, onSoundToggle, playDoneSound } = useAudio();
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  // Wrap agent event handler to play sound on agent_end
  const origHandler = handleAgentEventRef.current;
  useEffect(() => {
    handleAgentEventRef.current = (event) => {
      if (event.type === "agent_end" && soundEnabledRef.current) {
        playDoneSoundRef.current();
      }
      origHandler?.(event);
    };
  }, [origHandler, handleAgentEventRef]);

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
  const messageRefs = useMessageRefs(visibleMessages.length);

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
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
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
        <div className="flex flex-1 flex-col items-center justify-center overflow-hidden px-4 py-8">
          <div className="w-full max-w-[820px]">
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 16,
                marginRight: 16,
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
            {chatInputElement}
          </div>
        </div>
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
        <div ref={scrollContainerRef} onScroll={handleScroll} className="relative flex-1 overflow-y-auto px-4 py-4 [scrollbar-width:none]">
          <div className="mx-auto max-w-[820px]">

            {(() => {
              const toolResultsMap = new Map<string, import("@/lib/types").ToolResultMessage>();
              for (const msg of messages) {
                if (msg.role === "toolResult") {
                  toolResultsMap.set((msg as import("@/lib/types").ToolResultMessage).toolCallId, msg as import("@/lib/types").ToolResultMessage);
                }
              }
              let lastUserIdx = -1;
              for (let i = renderMessages.length - 1; i >= 0; i--) {
                if (renderMessages[i].role === "user") { lastUserIdx = i; break; }
              }
              let refIdx = 0;
              return renderMessages.map((msg, idx) => {
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && renderMessages[idx - 1].role === "assistant"
                    ? renderEntryIds[idx - 1]
                    : undefined;
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = isVisible ? refIdx++ : -1;
                let showTimestamp = false;
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
                const view = (
                  <MessageView
                    key={idx}
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
                    prevTimestamp={idx > 0 ? (renderMessages[idx - 1] as import("@/lib/types").AgentMessage & { timestamp?: number }).timestamp : undefined}
                    keywords={searchKeywords}
                    highlightEntryId={highlightEntryId}
                    isSearchMatch={matchedEntryIds.has(renderEntryIds[idx])}
                    cwd={session?.cwd}
                    sessionId={session?.id}
                  />
                );
                if (!isVisible) return view;
                return (
                  <div key={idx} ref={(el) => {
                    messageRefs.current[currentRefIdx] = el;
                    if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
                  }}>
                    {view}
                  </div>
                );
              });
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
        <ChatMinimap
          messages={renderMessages}
          streamingMessage={streamState.streamingMessage}
          scrollContainer={scrollContainerRef}
          messageRefs={messageRefs}
        />

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
