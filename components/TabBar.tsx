"use client";

import { useState } from "react";
import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";
import { Tooltip } from "./Tooltip";

export type Tab =
  | { kind: "file"; id: string; label: string; filePath: string }
  | { kind: "todo"; id: string; label: string }
  | { kind: "favorites"; id: string; label: string }
  | { kind: "translate"; id: string; label: string }
  | { kind: "toolCalls"; id: string; label: string }
  | { kind: "http"; id: string; label: string }
  | { kind: "json"; id: string; label: string };

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onContextMenu?: (tabId: string, x: number, y: number) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onContextMenu }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        background: "var(--bg-panel)",
        overflowX: "auto",
        flexShrink: 0,
        height: 36,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const tooltipContent =
          tab.kind === "file" ? tab.filePath : tab.label;
        const icon =
          tab.kind === "todo" ? (
            <TodoTabIcon />
          ) : tab.kind === "favorites" ? (
            <FavoritesTabIcon />
          ) : tab.kind === "translate" ? (
            <TranslateTabIcon />
          ) : tab.kind === "toolCalls" ? (
            <ToolCallsTabIcon />
          ) : tab.kind === "json" ? (
            <JsonTabIcon />
          ) : (
            getFileIcon(tab.label, 13)
          );
        return (
          <div
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu?.(tab.id, e.clientX, e.clientY);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 36,
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: 12,
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              transition: "background 0.1s, color 0.1s",
            }}
          >
            <span
              style={{
                flexShrink: 0,
                opacity: isActive ? 1 : 0.7,
                display: "flex",
                alignItems: "center",
              }}
            >
              {icon}
            </span>
            <Tooltip content={tooltipContent}>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
            >
              {tab.label}
            </span>
            </Tooltip>
            <Tooltip content={t("Close")}>
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 16, height: 16,
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: 3,
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: "background 0.1s, color 0.1s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
}

function TodoTabIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <polyline points="5 8 7 10 11 6" />
    </svg>
  );
}

function FavoritesTabIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function TranslateTabIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5h12" />
      <path d="M9 3v2" />
      <path d="M5 5c0 4 3 7 6 9" />
      <path d="M11 5c0 3-2 6-6 8" />
      <path d="M14 21l5-12 5 12" />
      <path d="M15.5 17h7" />
    </svg>
  );
}

function ToolCallsTabIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <line x1="2" y1="12" x2="2" y2="7" />
      <line x1="6" y1="12" x2="6" y2="4" />
      <line x1="10" y1="12" x2="10" y2="2" />
      <line x1="0.5" y1="12.5" x2="13.5" y2="12.5" />
    </svg>
  );
}

function JsonTabIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3 H6 a2 2 0 0 0 -2 2 v3 a2 2 0 0 1 -2 2 a2 2 0 0 1 2 2 v3 a2 2 0 0 0 2 2 h2" />
      <path d="M16 3 h2 a2 2 0 0 1 2 2 v3 a2 2 0 0 0 2 2 a2 2 0 0 0 -2 2 v3 a2 2 0 0 1 -2 2 h-2" />
    </svg>
  );
}