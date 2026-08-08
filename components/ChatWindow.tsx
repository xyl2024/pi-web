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
  collectShowFilePaths,
} from "@/lib/message-display";
import { MessageView } from "./MessageView";
import { ShowFileRenderer } from "./ShowFileRenderer";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { Tooltip } from "./Tooltip";
import { AgentTodoPanel } from "./AgentTodoPanel";
import { ReplayBar } from "./ReplayBar";
import { useAgentSession, type AgentPhase } from "@/hooks/useAgentSession";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "@/components/Toast";
import { useConfirm } from "./ConfirmDialog";
import { setChatHeaderActions } from "@/hooks/chatHeaderActionsStore";
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
  onFirstAssistantReady?: () => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  /** If set, navigate to this entry after the session finishes loading */
  scrollToEntryId?: string | null;
  /** Called after the scroll-to-entry navigation completes */
  onScrollComplete?: () => void;
  onNewSessionRequest?: () => void;
  /** Current cwd of the chat context — shown by ChatInput's CwdPicker. */
  cwd?: string | null;
  /** Fired when the CwdPicker picks a different cwd (new-session mode only). */
  onCwdChange?: (cwd: string) => void;
  /** When true (new-session mode, no session selected), render the CwdPicker. */
  showCwdPicker?: boolean;
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

// Starter prompt chips shown on the brand-new (empty) session screen.
// Clicking one fills the chat input via ChatInputHandle.insertText.
// Keys are i18n dictionary keys (English source = key).
const NEW_SESSION_PRESETS = [
  {
    key: "explore",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" /></svg>,
    titleKey: "Explore this codebase",
    descKey: "Understand the project structure and how it fits together",
    promptKey: "Walk me through this codebase: overall architecture, key modules, entry points, and how they fit together.",
  },
  {
    key: "review",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /><path d="M8.5 11l2 2 3.5-3.5" /></svg>,
    titleKey: "Review my code",
    descKey: "Find bugs, smells, and improvements",
    promptKey: "Review the code for bugs, code smells, and improvements. Point out concrete issues with file paths and line numbers.",
  },
  {
    key: "debug",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="13" r="6" /><path d="M12 7V4" /><path d="M8.5 5.5 7 4" /><path d="M15.5 5.5 17 4" /><path d="M9 13h.01" /><path d="M15 13h.01" /></svg>,
    titleKey: "Help me debug",
    descKey: "Reproduce, isolate, and fix a bug",
    promptKey: "Help me debug this issue: reproduce it, find the root cause, and fix it.",
  },
  {
    key: "tests",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2v6.5L4.5 18.5a2 2 0 0 0 1.8 2.9h11.4a2 2 0 0 0 1.8-2.9L14 8.5V2" /><path d="M8.5 2h7" /><path d="M7 16h10" /></svg>,
    titleKey: "Write tests",
    descKey: "Add unit tests for a module",
    promptKey: "Write unit tests for this module, covering the main paths and edge cases.",
  },
  {
    key: "optimize",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>,
    titleKey: "Optimize performance",
    descKey: "Profile and speed up slow code",
    promptKey: "Profile this code, find the performance bottlenecks, and suggest concrete optimizations.",
  },
  {
    key: "docs",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>,
    titleKey: "Document this project",
    descKey: "Generate a structured wiki from the source",
    promptKey: "Generate structured project documentation (a wiki) from the source code.",
  },
] as const;

// ── Per-turn process folding ──
//
// A "turn" runs from one anchor (user message) up to the next anchor. The
// non-final assistant messages in a turn — thinking, tool calls, intermediate
// text — are wrapped in a ProcessDetailsGroup so users can collapse them and
// focus on the final answer.
//
// While the agent is still running on the current turn (agentRunning is true
// and the anchor is the last user message), the process is rendered inline
// instead. Folding only kicks in once the whole turn finishes, so users see
// the full think → tool-call → intermediate text flow as it streams and then
// get a single collapsed summary at the end. Active streaming content for
// the in-progress message still lives in streamState.streamingMessage and is
// rendered separately below.

function isGroupAnchor(msg: AgentMessage): boolean {
  return msg.role === "user";
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

/** Turn-level gallery for show_file: renders every file referenced by the
 *  turn's show_file calls below the final answer, so the files stay visible
 *  even when the tool-call cards are folded into the process group. Only
 *  rendered once the turn has settled (ChatWindow gates on isLiveTurn).
 *
 *  Carousel: one file at a time in a fixed-height stage (images letterbox
 *  with object-fit: contain), glassy prev/next arrows, pill dots + counter
 *  in a footer bar, and keyboard ←/→ navigation. */
function ShowFileGallery({ paths, cwd }: { paths: string[]; cwd?: string }) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const count = paths.length;
  const safeIndex = count > 0 ? Math.min(index, count - 1) : 0;

  const goTo = (i: number) => {
    const next = ((i % count) + count) % count;
    if (next === safeIndex) return;
    // Direction follows the shortest arc around the circular track; ties (even
    // count, exact opposite) prefer forward so prev/next feel consistent.
    const delta = next - safeIndex;
    const half = count / 2;
    const d = delta > 0
      ? (delta <= half ? delta : delta - count)
      : (delta >= -half ? delta : delta + count);
    setDir(d >= 0 ? 1 : -1);
    setIndex(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); goTo(safeIndex - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); goTo(safeIndex + 1); }
  };

  // Single file — no carousel chrome, natural size.
  if (count === 1) {
    return <ShowFileRenderer filePath={paths[0]} cwd={cwd} />;
  }
  if (count === 0) return null;

  return (
    <div
      className="show-file-carousel"
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="region"
      aria-label={t("File gallery")}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "clamp(260px, 62vh, 500px)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        background: "var(--bg-panel)",
        overflow: "hidden",
        outline: "none",
      }}
    >
      {/* Stage: one file at a time, centered, slide-in on index change */}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <div
          key={safeIndex}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "10px 44px 8px 44px",
            animation: `${dir === 1 ? "gallery-slide-in-right" : "gallery-slide-in-left"} 0.32s cubic-bezier(0.22, 1, 0.36, 1)`,
          }}
        >
          <ShowFileRenderer key={`${safeIndex}-${paths[safeIndex]}`} filePath={paths[safeIndex]} cwd={cwd} fill />
        </div>

        {count > 1 && (
          <>
            <GalleryArrow side="left" onClick={() => goTo(safeIndex - 1)} label={t("Previous")} />
            <GalleryArrow side="right" onClick={() => goTo(safeIndex + 1)} label={t("Next")} />
          </>
        )}
      </div>

      {/* Footer: pill dots + counter */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "7px 12px",
          borderTop: "1px solid var(--border)",
          background: "var(--bg-subtle)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 5, minHeight: 12 }}>
          {count <= 12 && paths.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goTo(i)}
              aria-label={t("Go to file {n}").replace("{n}", String(i + 1))}
              aria-current={i === safeIndex}
              style={{
                width: i === safeIndex ? 18 : 6,
                height: 6,
                padding: 0,
                border: "none",
                borderRadius: 3,
                cursor: "pointer",
                background: i === safeIndex ? "var(--accent)" : "var(--text-dim)",
                opacity: i === safeIndex ? 1 : 0.45,
                transition: "width 0.2s ease, background 0.15s ease, opacity 0.15s ease",
              }}
            />
          ))}
        </div>
        <span
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            background: "var(--bg-selected)",
            padding: "2px 8px",
            borderRadius: 9,
          }}
        >
          {safeIndex + 1} / {count}
        </span>
      </div>
    </div>
  );
}

/** Circular glassy arrow used by the ShowFileGallery carousel. */
function GalleryArrow({ side, onClick, label }: { side: "left" | "right"; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        position: "absolute",
        top: "50%",
        transform: "translateY(-50%)",
        left: side === "left" ? 6 : undefined,
        right: side === "right" ? 6 : undefined,
        zIndex: 2,
        width: 30,
        height: 30,
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "50%",
        border: "1px solid rgba(255,255,255,0.22)",
        background: "rgba(0,0,0,0.45)",
        color: "#fff",
        cursor: "pointer",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        opacity: 0.65,
        transition: "opacity 0.15s ease, background 0.15s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = "1";
        e.currentTarget.style.background = "rgba(0,0,0,0.65)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = "0.65";
        e.currentTarget.style.background = "rgba(0,0,0,0.45)";
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        {side === "left"
          ? <polyline points="15 18 9 12 15 6" />
          : <polyline points="9 18 15 12 9 6" />}
      </svg>
    </button>
  );
}

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

function ChatWindowContent({ session, newSessionCwd, onAgentEnd, onSessionCreated, onFirstAssistantReady, modelsRefreshKey, chatInputRef, scrollToEntryId, onScrollComplete, onNewSessionRequest, cwd, onCwdChange, showCwdPicker, onRenameCompleted, onSessionNameChange }: Props) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [slashResources, setSlashResources] = useState<SlashResource[]>([]);
  const [isExporting, setIsExporting] = useState(false);

  // Tool call stats: wire the context emit into useAgentSession
  const statsEmit = useToolCallStatsEmit();

  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, contextUsage,
    displayModel: displayModelValue,
    agentPhase,
    isNew,
    messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    handleSend, handleAbort, handleNavigate, handleModelChange,
    handleToolPresetChange, handleThinkingLevelChange,
    userMessageHistory,
    activeLeafId, currentSessionId,
  } = useAgentSession({
    session, newSessionCwd, onAgentEnd, onSessionCreated, onFirstAssistantReady,
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
  // once on mount and update isStreaming imperatively.
  useEffect(() => {
    setAgentControls({
      switchModel: handleModelChange,
      switchThinkingLevel: handleThinkingLevelChange,
      switchToolPreset: handleToolPresetChange,
      abortStreaming: handleAbort,
      isStreaming: agentRunning,
    });
    return () => setAgentControls(null);
    // Handlers come from useAgentSession (stable useCallback refs); only
    // re-register when the bits that drive `when()` predicates change.
  }, [agentRunning]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Detect user-initiated scroll intent via wheel/touch events. We can't rely
  // on the scroll event alone: during fast streaming each chunk re-arms
  // isProgrammaticScrollRef for ~150ms, so the guard in handleScroll eats the
  // user's own scroll event and userScrolledUpRef never flips. wheel/touchmove
  // are not produced by scrollIntoView, so they capture intent before the
  // scroll happens and reliably disengage sticky-bottom mode.
  const handleUserScrollIntent = useCallback(() => {
    userScrolledUpRef.current = true;
    setShowToBottom(true);
  }, []);

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

  // Last user message / last turn anchor — used by
  // the turn renderer and the streaming gallery below.
  let lastUserIdx = -1;
  for (let i = renderMessages.length - 1; i >= 0; i--) {
    if (renderMessages[i].role === "user") { lastUserIdx = i; break; }
  }
  let lastAnchorIdx = -1;
  for (let i = renderMessages.length - 1; i >= 0; i--) {
    if (isGroupAnchor(renderMessages[i])) { lastAnchorIdx = i; break; }
  }
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

  // ── Auto-name: LLM-driven session name generation (moved up from ChatInput
  // when the button relocated to the AppShell top bar). The 3s "generated
  // name" label flash was dropped with the move — the sidebar updates
  // immediately and a toast already confirms the rename. ──
  const [isAutoNaming, setIsAutoNaming] = useState(false);
  const confirm = useConfirm();
  const currentSessionName = session?.name ?? null;
  const handleAutoName = useCallback(async () => {
    if (!sessionId) return;
    if (isAutoNaming) return;
    if (agentRunning) return;
    if (!firstUserMessageText || !firstUserMessageText.trim()) return;

    if (currentSessionName && currentSessionName.trim()) {
      const ok = await confirm({
        title: t("Auto-name session?"),
        description: t("This will replace the current session name."),
        confirmLabel: t("Auto-name"),
        cancelLabel: t("Cancel"),
        destructive: false,
      });
      if (!ok) return;
    }

    setIsAutoNaming(true);
    try {
      const suggestRes = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/auto-name`,
        { method: "POST" },
      );
      const suggestBody = (await suggestRes.json().catch(() => ({}))) as {
        name?: unknown;
        error?: unknown;
      };
      if (!suggestRes.ok || typeof suggestBody.name !== "string") {
        const reason = typeof suggestBody.error === "string" ? suggestBody.error : `HTTP ${suggestRes.status}`;
        throw new Error(reason);
      }
      const name = suggestBody.name.trim();
      if (!name) {
        toast.show({ kind: "error", message: t("Auto-naming returned an empty name") });
        return;
      }

      const patchRes = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      if (!patchRes.ok) {
        const body = (await patchRes.json().catch(() => ({}))) as { error?: unknown };
        const reason = typeof body.error === "string" ? body.error : `HTTP ${patchRes.status}`;
        throw new Error(reason);
      }

      onSessionNameChange?.(name);
      try { await onRenameCompleted?.(); } catch { /* sidebar refresh is best-effort */ }
      toast.show({ kind: "success", message: `${t("Renamed")} ${name}` });
    } catch (error) {
      toast.show({
        kind: "error",
        message: `${t("Auto-naming failed")}: ${
          error instanceof Error && error.message ? error.message : t("Network error")
        }`,
      });
    } finally {
      setIsAutoNaming(false);
    }
  }, [
    sessionId,
    isAutoNaming,
    agentRunning,
    firstUserMessageText,
    currentSessionName,
    confirm,
    toast,
    onSessionNameChange,
    onRenameCompleted,
    t,
  ]);

  // Auto-name is only available when there's a session, a usable first user
  // message, the agent isn't running, and no LLM call is already in flight.
  const canAutoName = Boolean(
    sessionId &&
    firstUserMessageText &&
    firstUserMessageText.trim() &&
    !agentRunning &&
    !isAutoNaming
  );

  // ── Publish Replay / Export / Auto-name actions for the AppShell top bar.
  // Rebuilt only when a dependency changes; the store's content guard then
  // skips AppShell re-renders when nothing actually changed. ──
  const headerActions = useMemo(() => ({
    onOpenReplay: openReplay,
    replayVisible: !streamState.isStreaming && !agentRunning && messages.length > 0,
    onExport: handleExport,
    exportVisible: Boolean(session) && !agentRunning,
    isExporting,
    onAutoName: handleAutoName,
    autoNameVisible: Boolean(session) && !agentRunning,
    canAutoName,
    isAutoNaming,
  }), [
    openReplay,
    streamState.isStreaming,
    agentRunning,
    messages.length,
    handleExport,
    session,
    isExporting,
    handleAutoName,
    canAutoName,
    isAutoNaming,
  ]);

  useEffect(() => {
    setChatHeaderActions(headerActions);
    return () => setChatHeaderActions(null);
  }, [headerActions]);

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

  // Fetch the profile username once for the new-session welcome line. Best-
  // effort: a missing / failed fetch falls back to "Guest", same as ProfileBlock.
  const [username, setUsername] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { username?: unknown }) => {
        if (cancelled) return;
        setUsername(typeof d.username === "string" ? d.username : null);
      })
      .catch(() => {
        if (!cancelled) setUsername(null);
      });
    return () => { cancelled = true; };
  }, []);

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      isStreaming={agentRunning}
      model={displayModelValue}
      modelNames={modelNames}
      modelList={modelList}
      onModelChange={handleModelChange}
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
      sessionId={currentSessionId}
      userMessageHistory={userMessageHistory}
      cwd={cwd ?? null}
      onCwdChange={onCwdChange ?? (() => {})}
      showCwdPicker={!!showCwdPicker}
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
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4">
            <div className="mb-8 flex flex-col items-center" style={{ fontFamily: "var(--font-mono)" }}>
              <span style={{ fontSize: 26, color: "var(--text)", fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1.2 }}>P<span style={{ color: "var(--accent)" }}>i</span> W<span style={{ color: "var(--accent)" }}>o</span>rk</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
                web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                <span style={{ margin: "0 6px", opacity: 0.5 }}>·</span>
                pi <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
              </span>
              <span
                aria-hidden
                style={{
                  marginTop: 16,
                  fontFamily: "var(--font-sans)",
                  fontSize: 15,
                  fontWeight: 500,
                  color: "var(--text)",
                  lineHeight: 1.5,
                  textAlign: "center",
                  maxWidth: 540,
                  padding: "0 16px",
                }}
              >
                {t("Hi, {name}, what shall we create together today?").replace("{name}", username ?? t("Guest"))}
              </span>
            </div>

            <div className="grid w-full max-w-[820px] grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {NEW_SESSION_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => chatInputRef?.current?.insertText(t(preset.promptKey))}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 10,
                    padding: "12px 14px",
                    background: "var(--bg-subtle)",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    cursor: "pointer", textAlign: "left",
                    transition: "border-color 0.15s, background 0.15s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-subtle)"; }}
                >
                  <span style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2, display: "flex" }}>{preset.icon}</span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", lineHeight: 1.3 }}>{t(preset.titleKey)}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{t(preset.descKey)}</span>
                  </span>
                </button>
              ))}
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
        />
        <div ref={scrollContainerRef} onScroll={handleScroll} onWheel={handleUserScrollIntent} onTouchMove={handleUserScrollIntent} className="relative flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto max-w-[820px]">

            {(() => {
              const toolResultsMap = new Map<string, ToolResultMessage>();
              for (const msg of messages) {
                if (msg.role === "toolResult") {
                  toolResultsMap.set(msg.toolCallId, msg);
                }
              }
              // Last turn anchor — computed in the
              // component body so the streaming gallery below shares it.
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
                  afterContent?: React.ReactNode;
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
                    onNavigate={agentRunning ? undefined : handleNavigate}
                    prevAssistantEntryId={agentRunning ? undefined : prevAssistantEntryId}
                    onEditContent={(content) => chatInputRef?.current?.insertIfEmpty(content)}
                    showTimestamp={showTimestamp}
                    keywords={searchKeywords}
                    highlightEntryId={highlightEntryId}
                    isSearchMatch={matchedEntryIds.has(renderEntryIds[idx])}
                    afterContent={opts.afterContent}
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
              // group. Each turn runs from an anchor (user message)
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

                // Anchor message (user)
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

                // The gallery only renders once the turn is fully settled:
                // while the agent is still working on this turn it is omitted
                // entirely, so the streaming answer text isn't pushed around
                // by files appearing beneath it.
                const isLiveTurn = agentRunning && userIdx === lastAnchorIdx && lastAnchorIdx !== -1;

                // Turn-level show_file gallery: every path referenced by the
                // turn's show_file calls, in call order.
                const turnPaths = collectShowFilePaths(renderMessages, userIdx + 1, endIdx);
                const turnGallery = turnPaths.length > 0
                  ? <ShowFileGallery paths={turnPaths} cwd={session?.cwd} />
                  : null;

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
                      afterContent: isLiveTurn ? null : turnGallery,
                    }),
                  );
                } else if (turnGallery && !isLiveTurn) {
                  // No trailing answer — the gallery still renders at the
                  // bottom of the turn's visible content (below the fold
                  // group / inline process).
                  rendered.push(<div key={`gallery-${userIdx}`}>{turnGallery}</div>);
                }

                idx = endIdx;
              }
              return rendered;
            })()}

            {streamState.isStreaming && streamState.streamingMessage && (
              <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelNames} />
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
