"use client";

import { useEffect, useRef, useState, useCallback, useMemo, RefObject } from "react";
import type { AgentMessage, AssistantMessage, TextContent } from "@/lib/types";

interface Props {
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
}

const MINIMAP_WIDTH = 36;

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

  // Compact centered layout: lines stacked with a small fixed step, centered vertically
  const TOOLTIP_HEIGHT = 22;
  const TOOLTIP_GAP = 2;
  const ROW_STEP = 12;
  const minimapHeightPx = containerHeight || 600;

  const nodeCenterPx = useCallback(
    (index: number) => {
      const stackH = Math.max(0, nodes.length - 1) * ROW_STEP;
      const startCenter = minimapHeightPx / 2 - stackH / 2;
      return startCenter + index * ROW_STEP;
    },
    [nodes.length, minimapHeightPx]
  );

  const tooltipPositions = useMemo(() => {
    if (!minimapHovered || nodes.length === 0) return [];
    const stackH = Math.max(0, nodes.length - 1) * ROW_STEP;
    const startCenter = minimapHeightPx / 2 - stackH / 2;
    const positions = nodes.map((_, i) =>
      Math.round(startCenter + i * ROW_STEP - TOOLTIP_HEIGHT / 2)
    );
    for (let pass = 0; pass < 10; pass++) {
      for (let i = 1; i < positions.length; i++) {
        const minTop = positions[i - 1] + TOOLTIP_HEIGHT + TOOLTIP_GAP;
        if (positions[i] < minTop) positions[i] = minTop;
      }
      for (let i = positions.length - 2; i >= 0; i--) {
        const maxTop = positions[i + 1] - TOOLTIP_HEIGHT - TOOLTIP_GAP;
        if (positions[i] > maxTop) positions[i] = maxTop;
      }
    }
    // Re-center the whole tooltip block vertically
    if (positions.length > 0) {
      const blockTop = positions[0];
      const blockBottom = positions[positions.length - 1] + TOOLTIP_HEIGHT;
      const shift = minimapHeightPx / 2 - (blockTop + blockBottom) / 2;
      for (let i = 0; i < positions.length; i++) positions[i] += shift;
    }
    for (let i = 0; i < positions.length; i++) {
      positions[i] = Math.max(0, Math.min(minimapHeightPx - TOOLTIP_HEIGHT, positions[i]));
    }
    return positions;
  }, [minimapHovered, nodes, minimapHeightPx]);

  if (!visible || nodes.length === 0) return null;

  // Node nearest to the current mouse position (for hover highlight)
  const mouseY = mouseYRatio !== null ? mouseYRatio * minimapHeightPx : null;
  const nearestIndex = mouseY !== null
    ? nodes.reduce((best, node) =>
        Math.abs(nodeCenterPx(node.index) - mouseY) < Math.abs(nodeCenterPx(best) - mouseY) ? node.index : best, 0)
    : null;

  return (
    <div
      ref={containerRef}
      onMouseEnter={() => setMinimapHovered(true)}
      onMouseLeave={() => { setMinimapHovered(false); setMouseYRatio(null); }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setMouseYRatio((e.clientY - rect.top) / rect.height);
      }}
      style={{
        width: MINIMAP_WIDTH,
        flexShrink: 0,
        position: "relative",
        cursor: "default",
        userSelect: "none",
        background: "transparent",
        overflow: "visible",
      }}
    >
      {/* Message lines — compact centered stack, click to jump */}
      {nodes.map((node) => {
        const color = getNodeColor(node.msg);
        const isActive = activeIndex === node.index;
        const isNearest = minimapHovered && nearestIndex === node.index;
        const highlight = isActive || isNearest;

        return (
          <div
            key={node.index}
            onClick={() => jumpTo(node)}
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
              cursor: "pointer",
              zIndex: 2,
            }}
          >
            {/* Horizontal line: equal length, click to jump */}
            <div
              style={{
                width: 14,
                height: 3,
                borderRadius: 1.5,
                background: color.bg,
                opacity: highlight ? 1 : 0.5,
                boxShadow: highlight ? `0 0 0 1px ${color.border}` : "none",
                flexShrink: 0,
                transition: "opacity 0.1s, box-shadow 0.1s",
              }}
            />
          </div>
        );
      })}

      {/* Tooltips for all nodes, collision-free positions */}
      {minimapHovered && nodes.map((node, i) => {
        const preview = getMessagePreview(node.msg);
        const color = getNodeColor(node.msg);
        const isNearest = nearestIndex === node.index;
        if (!preview || tooltipPositions.length === 0) return null;
        return (
          <div
            key={node.index}
            style={{
              position: "absolute",
              top: tooltipPositions[i],
              right: "100%",
              marginRight: 6,
              background: "var(--bg)",
              borderTop: `1px solid ${isNearest ? color.border : "var(--border)"}`,
              borderRight: `1px solid ${isNearest ? color.border : "var(--border)"}`,
              borderBottom: `1px solid ${isNearest ? color.border : "var(--border)"}`,
              borderLeft: `2px solid ${color.border}`,
              borderRadius: 4,
              padding: "2px 7px",
              width: 200,
              zIndex: 100,
              pointerEvents: "none",
              opacity: isNearest ? 1 : 0.45,
              transition: "top 0.1s, opacity 0.1s",
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: isNearest ? "var(--text)" : "var(--text-muted)",
                lineHeight: 1.4,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {preview}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
