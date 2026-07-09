"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Tooltip } from "./Tooltip";
import { useI18n } from "@/hooks/useI18n";
import { ShowFileRenderer } from "./ShowFileRenderer";
import { MermaidBlock } from "./MermaidBlock";
import { SvgBlock } from "./SvgBlock";
import { CodeBlock, copyText } from "./CodeBlock";
import { SHOW_FILE_TOOL_NAME } from "@/lib/show-file-tool-types";
import { PayloadChip } from "./PayloadChip";
import { ProviderIcon, hasProviderIcon } from "./ProviderIcon";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  /** Session id — used to fetch the captured provider request for this message. */
  sessionId?: string;
  /** Keywords to highlight with <mark> (from in-session search) */
  keywords?: string[];
  /** If this entryId matches, apply a flash animation */
  highlightEntryId?: string | null;
  /** Whether this message contains a search match (for highlight) */
  isSearchMatch?: boolean;
  /** Session working directory — used to render show_file tool calls */
  cwd?: string;
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

/** Wrap occurrences of any keyword in <mark> tags. Returns React nodes. */
function highlightKeywords(text: string, keywords?: string[], isSearchMatch?: boolean): React.ReactNode {
  if (!keywords || keywords.length === 0 || !isSearchMatch) return text;
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = escaped.join("|");
  const regex = new RegExp(pattern, "gi");
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(<mark key={key++} className="search-highlight">{match[0]}</mark>);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : text;
}

export function MessageView({ message, isStreaming, toolResults, modelNames, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, showTimestamp, prevTimestamp, keywords, highlightEntryId, isSearchMatch, cwd, sessionId }: Props) {
  const isFocused = !!(highlightEntryId && entryId === highlightEntryId);

  if (message.role === "user") {
    return (
      <div className={isFocused ? "search-flash" : undefined}>
        <UserMessageView message={message as UserMessage} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} keywords={keywords} isSearchMatch={isSearchMatch} />
      </div>
    );
  }
  if (message.role === "assistant") {
    return (
      <div className={isFocused ? "search-flash" : undefined}>
        <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} keywords={keywords} isSearchMatch={isSearchMatch} cwd={cwd} sessionId={sessionId} entryId={entryId} />
      </div>
    );
  }
  if (message.role === "toolResult") {
    return null;
  }
  return null;
}

function UserMessageView({ message, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, keywords, isSearchMatch }: {
  message: UserMessage;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  keywords?: string[];
  isSearchMatch?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [avatarOk, setAvatarOk] = useState(true);
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  const [avatarCacheKey] = useState(() => `${Date.now()}`);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { username?: string | null } | null) => {
        if (!cancelled && d && typeof d.username === "string") setUsername(d.username);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const time = formatTime(message.timestamp);
  const canFork = !!entryId && !!onFork;
  const canNavigate = !!prevAssistantEntryId && !!onNavigate;
  const hasMetadata = !!time || canFork || canNavigate || !!content;

  const copyContent = () => {
    copyText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const avatarSrc = `/api/profile/avatar?k=${encodeURIComponent(avatarCacheKey)}`;
  const showAvatarImg = avatarOk;
  const showAvatarPlaceholder = !avatarOk || !avatarLoaded;

  return (
    <div
      style={{ marginBottom: 16 }}
    >
      {/* Label row: avatar + username/You — mirrors AssistantMessageView's provider icon + model name */}
      <div
        style={{
          fontSize: 13,
          color: "var(--text-dim)",
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            width: 26, height: 26, flexShrink: 0,
            borderRadius: "50%", overflow: "hidden",
            background: "var(--bg-hover)",
            display: "flex", alignItems: "center", justifyContent: "center",
            border: "1px solid var(--border)",
          }}
        >
          {showAvatarImg && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={avatarSrc}
              src={avatarSrc}
              alt=""
              onLoad={() => setAvatarLoaded(true)}
              onError={() => { setAvatarOk(false); setAvatarLoaded(false); }}
              style={{
                width: "100%", height: "100%", objectFit: "cover",
                display: avatarLoaded ? "block" : "none",
              }}
            />
          )}
          {showAvatarPlaceholder && (
            <svg
              width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
              style={{ color: "var(--text-muted)" }}
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          )}
        </div>
        <span>{username ?? t("You")}</span>
      </div>

      {/* Bubble: image attachments + plain text body */}
      {(imageBlocks.length > 0 || content) && (
        <div
          style={{
            background: "var(--user-bg)",
            border: "1px solid rgba(59,130,246,0.2)",
            borderRadius: 12,
            padding: "8px 12px",
          }}
        >
          {imageBlocks.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
              {imageBlocks.map((img, i) => {
                const flat = img as unknown as { data?: string; mimeType?: string };
                const src = img.source
                  ? img.source.type === "base64"
                    ? `data:${img.source.media_type};base64,${img.source.data}`
                    : img.source.url ?? ""
                  : flat.data
                    ? `data:${flat.mimeType};base64,${flat.data}`
                    : "";
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={src}
                    alt=""
                    style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                  />
                );
              })}
            </div>
          )}

          {content && (
            <div
              style={{
                fontSize: 14,
                lineHeight: 1.6,
                color: "var(--text)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {highlightKeywords(content, keywords, isSearchMatch)}
            </div>
          )}
        </div>
      )}

      {/* Bottom metadata row: action buttons (hover) + timestamp (always, right) */}
      {hasMetadata && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
          {content && (
            <div style={{ display: "flex", gap: 3 }}>
              <Tooltip content={t("Copy message")}>
                <button
                  onClick={copyContent}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: copied ? "var(--accent)" : "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11, fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  {copied ? (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                  {copied ? t("Copied") : t("Copy")}
                </button>
              </Tooltip>
            </div>
          )}
          {(canFork || canNavigate) && (
            <div style={{ display: "flex", gap: 3 }}>
              {canNavigate && (
                <Tooltip content={t("Edit from here title")}>
                  <button
                    onClick={() => { onNavigate!(prevAssistantEntryId!); onEditContent?.(content); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: "3px 8px", height: 22,
                      background: "none", border: "none",
                      borderRadius: 5,
                      color: "var(--text-dim)",
                      cursor: "pointer",
                      fontSize: 11, fontWeight: 400,
                      whiteSpace: "nowrap",
                      transition: "color 0.12s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 10 20 15 15 20" />
                      <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                    </svg>
                    {t("Edit from here")}
                  </button>
                </Tooltip>
              )}
              {canFork && (
                <Tooltip content={forking ? t("Creating new session") : t("New session title")}>
                  <button
                    onClick={() => { onFork!(entryId!); }}
                    disabled={forking}
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: "3px 8px", height: 22,
                      background: "none", border: "none",
                      borderRadius: 5,
                      color: forking ? "var(--accent)" : "var(--text-dim)",
                      cursor: forking ? "not-allowed" : "pointer",
                      fontSize: 11, fontWeight: 400,
                      whiteSpace: "nowrap",
                      transition: "color 0.12s",
                    }}
                    onMouseEnter={(e) => { if (!forking) e.currentTarget.style.color = "var(--accent)"; }}
                    onMouseLeave={(e) => { if (!forking) e.currentTarget.style.color = "var(--text-dim)"; }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="6" y1="3" x2="6" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                    {forking ? t("Creating...") : t("New session")}
                  </button>
                </Tooltip>
              )}
            </div>
          )}
          {time && <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>}
        </div>
      )}
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  showTimestamp,
  prevTimestamp,
  keywords,
  isSearchMatch,
  cwd,
  sessionId,
  entryId,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  keywords?: string[];
  isSearchMatch?: boolean;
  cwd?: string;
  sessionId?: string;
  entryId?: string;
}) {
  const { t } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const blocks = message.content ?? [];
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || !message.timestamp) return map;
    for (const [callId, result] of toolResults) {
      if (result.timestamp && message.timestamp) {
        const secs = Math.round((result.timestamp - message.timestamp) / 1000);
        if (secs > 0) map.set(callId, secs);
      }
    }
    return map;
  }, [toolResults, message.timestamp]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const copyContent = () => {
    copyText(textContent)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Silent — UI just doesn't flip to "Copied".
        console.warn("clipboard write failed");
      });
  };

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = Date.now();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const bs = blocksRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      bs.forEach((_, i) => {
        if (!blockStartTimesRef.current.has(i)) blockStartTimesRef.current.set(i, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < bs.length - 1; i++) {
          if (!next.has(i) && blockStartTimesRef.current.has(i)) {
            const start = blockStartTimesRef.current.get(i)!;
            const nextStart = blockStartTimesRef.current.get(i + 1) ?? now;
            next.set(i, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      let chars = 0;
      for (const b of bs) {
        if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
        else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
        else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
      }
      if (chars === 0) return;
      if (streamStartRef.current === null) streamStartRef.current = now;
      const elapsed = (now - streamStartRef.current) / 1000;
      if (elapsed > 0.5) setTps(chars / 4 / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  return (
    <div
      style={{ marginBottom: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Model label */}
      <div
        style={{
          fontSize: 13,
          color: "var(--text-dim)",
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        {message.provider && (
          <>
            {hasProviderIcon(message.provider) && (
              <ProviderIcon id={message.provider} size={16} />
            )}
            <span>{modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}</span>
          </>
        )}
        {sessionId && entryId && (
          <PayloadChip sessionId={sessionId} entryId={entryId} pending={!!isStreaming} />
        )}
        {isStreaming && (() => {
          let chars = 0;
          for (const b of blocks) {
            if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
            else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
            else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
          }
          const est = Math.round(chars / 4);
          return (
            <>

              {est > 0 && (
                <Tooltip content={t("Estimated tokens while streaming")}><span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {tps !== null && (() => {
                    const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
                    return (
                      <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: bg, color: "#fff", fontSize: 11, fontWeight: 400 }}>
                        {tps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                </span></Tooltip>
              )}
            </>
          );
        })()}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {blocks.map((block, i) => (
          <BlockView key={i} block={block} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(i) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} keywords={keywords} isSearchMatch={isSearchMatch} cwd={cwd} />
        ))}
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 8,
      }}>
        {message.usage && !isStreaming && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {formatUsage(message.usage, t)}
          </div>
        )}
        {textContent && !isStreaming && (
          <Tooltip content={t("Copy message")}>
          <button
            onClick={copyContent}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 8px", height: 22,
              background: "none", border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11, fontWeight: 400,
              whiteSpace: "nowrap",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copied ? t("Copied") : t("Copy")}
          </button>
          </Tooltip>
        )}
        {time && !isStreaming && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
      </div>
    </div>
  );
}

function BlockView({ block, toolResults, isStreaming, streamingDuration, toolCallDurations, keywords, isSearchMatch, cwd }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; keywords?: string[]; isSearchMatch?: boolean; cwd?: string }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} keywords={keywords} isSearchMatch={isSearchMatch} isStreaming={isStreaming} />;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} keywords={keywords} isSearchMatch={isSearchMatch} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} isRunning={isStreaming && !result} duration={duration} cwd={cwd} />;
  }
  return null;
}

/** Wrap keywords in <mark> HTML tags (for use with ReactMarkdown which renders HTML) */
function highlightTextAsHtml(text: string, keywords?: string[], isSearchMatch?: boolean): string {
  if (!keywords || keywords.length === 0 || !isSearchMatch) return text;
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = escaped.join("|");
  const regex = new RegExp(pattern, "gi");
  return text.replace(regex, (match) => `<mark class="search-highlight">${match}</mark>`);
}

function TextBlock({ block, keywords, isSearchMatch, isStreaming }: { block: TextContent; keywords?: string[]; isSearchMatch?: boolean; isStreaming?: boolean }) {
  const text = highlightTextAsHtml(block.text, keywords, isSearchMatch);
  // Memoize the components map so ReactMarkdown doesn't see a new identity
  // on every parent re-render. Without this, the new `code` closure produces
  // a new <MermaidBlock> element on every render, which can cause the
  // mermaid subtree to remount and re-parse — visible as flicker.
  // The stable `key={raw}` on MermaidBlock is a second line of defense.
  const components = useMemo(
    () => ({
      code({ className, children, ...props }: { className?: string; children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) {
        const lang = className?.replace("language-", "") ?? "";
        const raw = String(children ?? "");
        const isBlock = className?.includes("language-") || raw.includes("\n");
        if (isBlock) {
          if (lang === "mermaid") {
            return <MermaidBlock key={raw} code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />;
          }
          if (lang === "svg") {
            return <SvgBlock key={raw} code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />;
          }
          return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
        }
        return (
          <code
            style={{
              background: "var(--bg-selected)",
              padding: "1px 4px",
              borderRadius: 3,
              fontFamily: "var(--font-mono)",
              fontSize: "0.9em",
            }}
            {...props}
          >
            {children}
          </code>
        );
      },
      pre({ children }: { children?: React.ReactNode }) {
        // Unwrap <pre> wrapper — CodeBlock handles its own container
        return <>{children}</>;
      },
    }),
    [isStreaming],
  );
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ThinkingBlock({ block, duration, keywords, isSearchMatch }: { block: ThinkingContent; duration?: number; keywords?: string[]; isSearchMatch?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        fontSize: 13,
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "6px 10px",
          background: "var(--bg-panel)",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        <span>{t("Thinking")}</span>
        {duration !== undefined && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            background: "var(--bg-panel)",
            borderTop: "1px solid var(--border)",
          }}
        >
          {highlightKeywords(block.thinking, keywords, isSearchMatch)}
        </div>
      )}
    </div>
  );
}


function ToolCallBlock({ block, result, isRunning, duration, cwd }: { block: ToolCallContent; result?: ToolResultMessage; isRunning?: boolean; duration?: number; cwd?: string }) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = JSON.stringify(block.input, null, 2);

  // Result display
  const resultText = result
    ? result.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = result?.isError ?? false;

  // Special render for show_file: keep the standard tool call card and append a
  // rendered viewer below it. The viewer is mounted speculatively from
  // block.input.paths so it starts loading while the tool is still running.
  const isShowFile = block.toolName === SHOW_FILE_TOOL_NAME;
  const showFilePaths: string[] | null = (() => {
    if (!isShowFile || !block.input) return null;
    const raw = block.input.paths;
    if (!Array.isArray(raw)) return null;
    const filtered = raw.filter((p): p is string => typeof p === "string" && p.length > 0);
    return filtered.length > 0 ? filtered : null;
  })();

  return (
    <div
      style={{
        borderRadius: 7,
        overflow: "hidden",
        fontSize: 12,
        border: isError ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(34,197,94,0.25)",
        background: isError ? "rgba(248,113,113,0.05)" : "rgba(34,197,94,0.04)",
      }}
    >
      {/* ── Tool call header ── */}
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          padding: "6px 10px",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
          minWidth: 0,
        }}
      >
        <span style={{ color: isError ? "#f87171" : "#16a34a", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>
          {block.toolName}
        </span>
        <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {getToolPreview(block)}
        </span>
        {duration !== undefined && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {/* ── Expanded: input args ── */}
      {expanded && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.5,
            overflow: "auto",
            background: "var(--bg-subtle)",
            borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {inputStr}
        </pre>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && (
        <PairedResult
          text={resultText ?? ""}
          isEmpty={resultIsEmpty}
          isError={isError}
        />
      )}

      {/* ── show_file inline renderer (below generic UI) ── */}
      {isShowFile && showFilePaths && (
        <div
          style={{
            padding: "10px",
            borderTop: "1px solid rgba(34,197,94,0.2)",
            background: "var(--bg)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {showFilePaths.map((p, i) => (
            <ShowFileRenderer key={`${i}-${p}`} filePath={p} cwd={cwd} />
          ))}
        </div>
      )}
    </div>
  );
}

function PairedResult({ text, isEmpty, isError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
        background: isError ? "rgba(248,113,113,0.04)" : "var(--bg-subtle)",
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "#f87171" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: 12,
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
        {isEmpty ? `(${t("No output")})` : text}
      </pre>
    </div>
  );
}


function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}, t: ReturnType<typeof useI18n>["t"]): string {
  const parts = [];
  if (usage.input) parts.push(`${usage.input.toLocaleString()} ${t("in")}`);
  if (usage.output) parts.push(`${usage.output.toLocaleString()} ${t("out")}`);
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} ${t("cache")}`);
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}
