"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMessage, SessionInfo } from "@/lib/types";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { Tooltip } from "./Tooltip";
import { SessionHeatmap } from "./SessionHeatmap";
import { GithubHeatmap, GithubHeatmapPlaceholder } from "./GithubHeatmap";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { useAgentSession, type AgentPhase } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useI18n, type Locale } from "@/hooks/useI18n";
import type { SlashResource } from "./ChatInput";
import { ToolCallStatsProvider, useToolCallStatsEmit } from "@/hooks/ToolCallStatsContext";
import { useToolCallStats } from "@/hooks/useToolCallStats";
import { ToolCallStatsDrawer } from "./ToolCallStatsDrawer";
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
  onSelectSession?: (session: SessionInfo) => void;
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

const TYPEWRITER_PHRASES: Record<Locale, string[]> = {
  en: [
    "ready when you are.",
    "ask me anything.",
    "let's build something cool.",
    "explore your codebase.",
    "draft an email.",
    "summarize that paper.",
    "plan your weekend.",
    "explain it like I'm five.",
    "pair-program with me.",
    "fix that pesky bug.",
    "translate to Chinese.",
    "write a haiku.",
    "brainstorm ideas.",
    "review my pull request.",
    "what should we cook tonight?",
    "ship it.",
    "make it pretty.",
    "talk it through with me.",
  ],
  zh: [
    "我准备好了。",
    "随时问我任何问题。",
    "一起做点有趣的东西。",
    "探索你的代码库。",
    "帮你起草一封邮件。",
    "总结那篇论文。",
    "规划你的周末。",
    "像讲给五岁小孩一样解释。",
    "和我一起结对编程。",
    "修掉那个烦人的 bug。",
    "翻译成中文。",
    "写一首俳句。",
    "一起头脑风暴。",
    "帮我 review 这个 PR。",
    "今晚吃什么？",
    "发版吧。",
    "把它变好看。",
    "陪我梳理一下思路。",
  ],
};

function Typewriter({ phrases }: { phrases: string[] }) {
  const [phraseIdx, setPhraseIdx] = useState(() => Math.floor(Math.random() * phrases.length));
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [caretOn, setCaretOn] = useState(true);

  useEffect(() => {
    const blink = setInterval(() => setCaretOn((v) => !v), 530);
    return () => clearInterval(blink);
  }, []);

  useEffect(() => {
    const current = phrases[phraseIdx];
    let timeout: ReturnType<typeof setTimeout>;
    if (!deleting && text === current) {
      timeout = setTimeout(() => setDeleting(true), 1800);
    } else if (deleting && text === "") {
      setDeleting(false);
      setPhraseIdx((i) => (i + 1) % phrases.length);
    } else {
      const next = deleting ? current.slice(0, text.length - 1) : current.slice(0, text.length + 1);
      timeout = setTimeout(() => setText(next), deleting ? 28 : 55);
    }
    return () => clearTimeout(timeout);
  }, [text, deleting, phraseIdx, phrases]);

  return (
    <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
      {text}
      <span style={{ opacity: caretOn ? 1 : 0, color: "var(--accent)", marginLeft: 1 }}>▍</span>
    </span>
  );
}

function ChatWindowContent({ session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, scrollToEntryId, onScrollComplete, onNewSessionRequest, onSelectSession }: Props) {
  const { locale, t } = useI18n();
  const [slashResources, setSlashResources] = useState<SlashResource[]>([]);

  // Tool call stats: wire the context emit into useAgentSession
  const statsEmit = useToolCallStatsEmit();

  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, forkingEntryId,
    isCompacting, compactError, displayModel: displayModelValue,
    agentPhase,
    isNew,
    messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handleAbortCompaction,
    handleToolPresetChange, handleThinkingLevelChange, handleAgentEventRef,
  } = useAgentSession({
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey,
    statsEmit,
    scrollToEntryId,
    onScrollComplete,
  });

  // Tool call stats hook
  const { snapshot, isDrawerOpen, toggleDrawer } = useToolCallStats(messages);

  // ── GitHub username from ~/.pi-web/config.yaml (one-shot fetch on mount) ──
  const [githubUsername, setGithubUsername] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => r.ok ? r.json() : null)
      .then((d: { github_username?: string } | null) => {
        if (cancelled || !d) return;
        setGithubUsername((d.github_username ?? "").trim());
      })
      .catch(() => { /* ignore — heatmap hides itself if username is empty */ });
    return () => { cancelled = true; };
  }, []);

  // Running summary for the drawer toggle button
  const runningSummary = agentPhase?.kind === "running_tools" && agentPhase.tools.length > 0
    ? t("{n} running · {m} total").replace("{n}", String(agentPhase.tools.length)).replace("{m}", String(snapshot.totalCount))
    : snapshot.totalCount > 0
      ? t("{n} total").replace("{n}", String(snapshot.totalCount))
      : undefined;

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
  }, [session?.id]);

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

  const onDrop = useCallback((files: File[]) => {
    chatInputRef?.current?.addImages(files);
  }, [chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const messageRefs = useMessageRefs(visibleMessages.length);

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
      slashResources={slashResources}
      slashResourceKey={slashResourceKey}
      onSlashAction={(action) => { if (action === "new") onNewSessionRequest?.(); }}
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
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full max-w-[820px]">
            {newSessionCwd && (
              <SessionHeatmap cwd={newSessionCwd} onOpenSession={onSelectSession} />
            )}
            {newSessionCwd && (
              githubUsername
                ? <GithubHeatmap username={githubUsername} />
                : <GithubHeatmapPlaceholder />
            )}
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 16,
                marginRight: 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, flex: 1, lineHeight: 1.4 }}>
                <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text)" }}>π</span>
                <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, letterSpacing: "-0.01em" }}>Pi Agent Web</span>
                <span style={{ fontSize: 14, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  <Typewriter phrases={TYPEWRITER_PHRASES[locale]} />
                </span>
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
      <div className="relative flex flex-1 overflow-hidden">
        <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto py-4 [scrollbar-width:none]">
          <div className="mx-auto max-w-[820px] px-4">

            {(() => {
              const toolResultsMap = new Map<string, import("@/lib/types").ToolResultMessage>();
              for (const msg of messages) {
                if (msg.role === "toolResult") {
                  toolResultsMap.set((msg as import("@/lib/types").ToolResultMessage).toolCallId, msg as import("@/lib/types").ToolResultMessage);
                }
              }
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") { lastUserIdx = i; break; }
              }
              let refIdx = 0;
              return messages.map((msg, idx) => {
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                    ? entryIds[idx - 1]
                    : undefined;
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = isVisible ? refIdx++ : -1;
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  showTimestamp = true;
                  for (let j = idx + 1; j < messages.length; j++) {
                    const r = messages[j].role;
                    if (r === "user") break;
                    if (r === "assistant") { showTimestamp = false; break; }
                  }
                  // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                  if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                    showTimestamp = false;
                  }
                }
                const view = (
                  <MessageView
                    key={idx}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    entryId={entryIds[idx]}
                    onFork={agentRunning || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onNavigate={agentRunning ? undefined : handleNavigate}
                    prevAssistantEntryId={agentRunning ? undefined : prevAssistantEntryId}
                    onEditContent={(content) => chatInputRef?.current?.insertIfEmpty(content)}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as import("@/lib/types").AgentMessage & { timestamp?: number }).timestamp : undefined}
                    keywords={searchKeywords}
                    highlightEntryId={highlightEntryId}
                    isSearchMatch={matchedEntryIds.has(entryIds[idx])}
                    cwd={session?.cwd}
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
              <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelNames} cwd={session?.cwd} />
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
          messages={messages}
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

        {/* Tool call stats drawer — jump to chat message on click */}
        {(() => {
          // Build a map from toolCallId → visible message index
          const toolCallToVisibleIdx = new Map<string, number>();
          let vi = 0;
          for (const msg of messages) {
            if (msg.role !== "user" && msg.role !== "assistant") continue;
            if (msg.role === "assistant") {
              for (const block of msg.content) {
                if (block.type === "toolCall") {
                  toolCallToVisibleIdx.set((block as import("@/lib/types").ToolCallContent).toolCallId, vi);
                }
              }
            }
            vi++;
          }
          const handleScrollToToolCall = (toolCallId: string) => {
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
          };
          return (
            <ToolCallStatsDrawer
              snapshot={snapshot}
              open={isDrawerOpen}
              onToggle={toggleDrawer}
              runningSummary={runningSummary}
              onScrollToToolCall={handleScrollToToolCall}
            />
          );
        })()}
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
