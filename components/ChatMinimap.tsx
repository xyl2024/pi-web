"use client";

import { useEffect, useRef, useState, useCallback, useMemo, RefObject, UIEvent } from "react";
import type { AgentMessage, AssistantMessage, TextContent } from "@/lib/types";

interface Props {
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
}

const MINIMAP_WIDTH = 36;
const PANEL_WIDTH = 220;
const PANEL_GAP = 8;
const PANEL_MAX = 480;
const PANEL_VERTICAL_MARGIN = 16;
const PREVIEW_LEN = 40;
const ROW_STEP = 12;
const PANEL_ROW_HEIGHT = 24; // padding 4+4 + lineHeight 16

// Unicode-safe slice (handles emoji + CJK without breaking surrogate pairs)
function truncatePreview(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("") + "…";
}

function getMessagePreview(msg: AgentMessage | Partial<AgentMessage>): string {
  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") return content.slice(0, 200);
    if (Array.isArray(content)) {
      return (content as { type: string; text?: string }[])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n")
        .slice(0, 200);
    }
    return "";
  }
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    const text = blocks
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    if (text) return text.slice(0, 200);
    const toolNames = blocks
      .filter((b) => b.type === "toolCall")
      .map((b) => (b as { type: string; toolName: string }).toolName);
    if (toolNames.length) return toolNames.join(", ");
    return "";
  }
  return "";
}

function getNodeColor(msg: AgentMessage | Partial<AgentMessage>): { bg: string; border: string } {
  if (msg.role === "user") {
    return { bg: "var(--accent)", border: "var(--accent)" };
  }
  return { bg: "#f59e0b", border: "#f59e0b" };
}

function hasTextContent(msg: AgentMessage | Partial<AgentMessage>): boolean {
  if (msg.role === "user") return true;
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    return blocks.some((b) => b.type === "text");
  }
  return false;
}

interface NodeInfo {
  top: number;        // absolute scroll offset of the message element
  msg: AgentMessage | Partial<AgentMessage>;
  el: HTMLDivElement;
  index: number;
}

export function ChatMinimap({ messages, streamingMessage, scrollContainer, messageRefs }: Props) {
  const [visible, setVisible] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelScrollRef = useRef<HTMLDivElement>(null);
  const panelRectRef = useRef<DOMRect | null>(null);
  const [panelHoverIndex, setPanelHoverIndex] = useState<number | null>(null);

  const allMessages = useMemo(
    () => (streamingMessage ? [...messages, streamingMessage] : messages) as (AgentMessage | Partial<AgentMessage>)[],
    [messages, streamingMessage]
  );
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  // Rebuild node list from real DOM refs (positions used only for active detection)
  const rebuildRef = useRef<() => void>(null!);
  rebuildRef.current = () => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;

    const totalH = scrollEl.scrollHeight;
    const clientH = scrollEl.clientHeight;
    setVisible(totalH - clientH > 20 && !!messageRefs.current?.length);

    const refs = messageRefs.current;
    const newNodes: NodeInfo[] = [];
    let refIndex = 0;

    const allMessages = allMessagesRef.current;
    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i];
      if (msg.role !== "user" && msg.role !== "assistant") continue;

      const el = refs?.[refIndex];
      refIndex++;

      if (!hasTextContent(msg)) continue;

      if (el && totalH > 0) {
        const elRect = el.getBoundingClientRect();
        const containerRect = scrollEl.getBoundingClientRect();
        const top = elRect.top - containerRect.top + scrollEl.scrollTop;
        newNodes.push({ top, msg, el, index: newNodes.length });
      }
    }
    setNodes(newNodes);
  };

  const rebuild = useCallback(() => rebuildRef.current(), []);

  // Update which node is "active" (nearest to the top of the viewport)
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const updateActive = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const marker = scrollEl.scrollTop + scrollEl.clientHeight * 0.25;
    const ns = nodesRef.current;
    let active = 0;
    for (let i = 0; i < ns.length; i++) {
      if (ns[i].top <= marker) active = i;
      else break;
    }
    setActiveIndex(active);
  }, [scrollContainer]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const onScroll = () => updateActive();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => { rebuild(); updateActive(); });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    rebuild();
    updateActive();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [scrollContainer, rebuild, updateActive]);

  // Re-measure when message count changes (new messages arrive)
  useEffect(() => {
    const t = setTimeout(() => { rebuild(); updateActive(); }, 50);
    return () => clearTimeout(t);
  }, [messages.length, rebuild, updateActive]);

  const jumpTo = useCallback((node: NodeInfo) => {
    node.el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Measure the minimap container height (for compact centered layout)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerHeight(el.clientHeight));
    ro.observe(el);
    setContainerHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [visible]);

  // Keep the panel's screen rect fresh while hovered (scroll + resize update positions)
  useEffect(() => {
    if (!minimapHovered) {
      panelRectRef.current = null;
      setPanelHoverIndex(null);
      return;
    }
    const el = panelScrollRef.current;
    if (!el) return;
    const update = () => {
      panelRectRef.current = el.getBoundingClientRect();
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [minimapHovered]);

  const minimapHeightPx = containerHeight || 600;

  const nodeCenterPx = useCallback(
    (index: number) => {
      const stackH = Math.max(0, nodes.length - 1) * ROW_STEP;
      const startCenter = minimapHeightPx / 2 - stackH / 2;
      return startCenter + index * ROW_STEP;
    },
    [nodes.length, minimapHeightPx]
  );

  // Panel geometry: dynamic height = content size, capped at PANEL_MAX
  const contentHeight = nodes.length * PANEL_ROW_HEIGHT;
  const panelHeight = Math.min(PANEL_MAX, contentHeight);
  const panelTop = Math.max(
    PANEL_VERTICAL_MARGIN,
    ((containerHeight || minimapHeightPx) - panelHeight) / 2
  );

  // Independent scrolling: forward wheel deltas to the panel instead of the chat
  const handlePanelWheel = useCallback((e: UIEvent<HTMLDivElement>) => {
    const el = panelScrollRef.current;
    if (!el) return;
    // React's synthetic onWheel is non-passive by default; preventDefault works here.
    e.preventDefault();
    e.stopPropagation();
    const native = e.nativeEvent as unknown as WheelEvent;
    el.scrollTop += native.deltaY;
  }, []);

  // Node nearest to the current mouse position (for hover highlight)
  // When the cursor is over the panel, snap to the row directly under it (panel-local coords).
  // Otherwise fall back to the tick stack math (centered within the chat container).
  const mouseY = mouseYRatio !== null ? mouseYRatio * minimapHeightPx : null;
  const tickNearestIndex = nodes.length > 0 && mouseY !== null
    ? nodes.reduce((best, node) =>
        Math.abs(nodeCenterPx(node.index) - mouseY) < Math.abs(nodeCenterPx(best) - mouseY) ? node.index : best, 0)
    : null;
  const nearestIndex = panelHoverIndex !== null ? panelHoverIndex : tickNearestIndex;

  // Auto-scroll panel to bottom when new messages arrive while user is at the tail
  const lastIndex = nodes.length - 1;
  const atTail = lastIndex >= 0 && (activeIndex === lastIndex || nearestIndex === lastIndex);
  useEffect(() => {
    if (!minimapHovered || !atTail) return;
    const el = panelScrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight) return;
    el.scrollTop = el.scrollHeight;
  }, [nodes.length, minimapHovered, atTail]);

  // Single click handler: collapse panel and jump to the clicked message
  const handleJump = useCallback((node: NodeInfo) => {
    jumpTo(node);
    setMinimapHovered(false);
  }, [jumpTo]);

  if (!visible || nodes.length === 0) return null;

  const wrapperWidth = MINIMAP_WIDTH + (minimapHovered ? PANEL_WIDTH + PANEL_GAP : 0);

  return (
    <div
      ref={containerRef}
      onMouseEnter={() => setMinimapHovered(true)}
      onMouseLeave={() => { setMinimapHovered(false); setMouseYRatio(null); }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setMouseYRatio((e.clientY - rect.top) / rect.height);
        // If the cursor is inside the panel, anchor the highlight to the row under it
        const pr = panelRectRef.current;
        const panelEl = panelScrollRef.current;
        if (pr && panelEl && nodes.length > 0) {
          if (e.clientX >= pr.left && e.clientX <= pr.right &&
              e.clientY >= pr.top && e.clientY <= pr.bottom) {
            const localY = e.clientY - pr.top + panelEl.scrollTop;
            const idx = Math.floor(localY / PANEL_ROW_HEIGHT);
            setPanelHoverIndex(Math.max(0, Math.min(nodes.length - 1, idx)));
            return;
          }
        }
        setPanelHoverIndex(null);
      }}
      style={{
        width: wrapperWidth,
        position: "absolute",
        right: 0,
        top: 0,
        bottom: 0,
        cursor: "default",
        userSelect: "none",
        background: "transparent",
        overflow: "visible",
        zIndex: 5,
        transition: "width 120ms ease",
      }}
    >
      {/* Tick strip — 36px compact centered stack, click to jump */}
      <div
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: MINIMAP_WIDTH,
        }}
      >
        {nodes.map((node) => {
          const color = getNodeColor(node.msg);
          const isActive = activeIndex === node.index;
          const isNearest = nearestIndex === node.index;

          return (
            <div
              key={node.index}
              style={{
                position: "absolute",
                top: nodeCenterPx(node.index),
                transform: "translateY(-50%)",
                left: 0,
                right: 0,
                height: "10px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
                zIndex: 2,
              }}
            >
              <div
                style={{
                  width: isActive ? 14 : 9,
                  height: 3,
                  borderRadius: 1.5,
                  background: color.bg,
                  opacity: isActive ? 1 : (isNearest ? 0.65 : 0.28),
                  boxShadow: isActive
                    ? `0 0 0 1px ${color.border}`
                    : (isNearest ? `0 0 0 1px ${color.border}` : "none"),
                  flexShrink: 0,
                  transition: "opacity 0.1s, box-shadow 0.1s, width 0.1s",
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Scrollable message-list panel — fixed height, vertically centered, mounts on hover */}
      {minimapHovered && (
        <div
          ref={panelScrollRef}
          onWheel={handlePanelWheel}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            const row = target.closest<HTMLElement>("[data-node-index]");
            if (!row) return;
            const idx = Number(row.dataset.nodeIndex);
            const node = nodes.find((n) => n.index === idx);
            if (node) handleJump(node);
          }}
          style={{
            position: "absolute",
            right: MINIMAP_WIDTH + PANEL_GAP,
            top: panelTop,
            height: panelHeight,
            width: PANEL_WIDTH,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            overflowY: "auto",
            overflowX: "hidden",
            zIndex: 100,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            opacity: 1,
            transition: "opacity 120ms ease",
          }}
        >
          {nodes.map((node) => {
            const color = getNodeColor(node.msg);
            const isActive = activeIndex === node.index;
            const isNearest = nearestIndex === node.index;
            const preview = getMessagePreview(node.msg);
            const role = node.msg.role === "user" ? "U" : "A";

            return (
              <div
                key={node.index}
                data-node-index={node.index}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  cursor: "pointer",
                  fontSize: 11,
                  lineHeight: "16px",
                  background: isActive ? "var(--bg)" : "transparent",
                  borderLeft: `2px solid ${isNearest ? color.border : "transparent"}`,
                  color: isNearest ? "var(--text)" : "var(--text-muted)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: 2,
                    background: color.bg,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {preview ? truncatePreview(preview.replace(/\s+/g, " ").trim(), PREVIEW_LEN) : "(no text)"}
                </span>
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: 10,
                    opacity: 0.7,
                    color: "var(--text-dim)",
                  }}
                >
                  {role}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
