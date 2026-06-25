"use client";

import { useRef, useEffect, useCallback } from "react";
import { useI18n } from "@/hooks/useI18n";
import { Tooltip } from "./Tooltip";

interface Props {
  query: string;
  onQueryChange: (q: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (v: boolean) => void;
  matchIndex: number;
  matchCount: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  visible: boolean;
}

// VS Code-style inline search bar for the file viewer. Dumb and fully
// controlled — the parent (TextFileViewer) owns query/case-sensitive/match
// state and recomputes matches on its own. This component only renders the
// input row and forwards keyboard/mouse events.
export function FileSearchBar({
  query,
  onQueryChange,
  caseSensitive,
  onCaseSensitiveChange,
  matchIndex,
  matchCount,
  onPrev,
  onNext,
  onClose,
  visible,
}: Props) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus + select the existing query so the user can retype quickly
  // after toggling Aa or reopening the bar.
  useEffect(() => {
    if (!visible) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [visible]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) onPrev();
        else onNext();
      }
    },
    [onClose, onNext, onPrev],
  );

  if (!visible) return null;

  const hasMatches = matchCount > 0;
  const prevDisabled = !hasMatches || matchIndex <= 0;
  const nextDisabled = !hasMatches || matchIndex >= matchCount - 1;
  const counterText = hasMatches
    ? `${matchIndex + 1} / ${matchCount}`
    : (query ? t("No file matches") : "");

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        flexShrink: 0,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--text-muted)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0 }}
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("Search file...")}
        style={{
          flex: 1,
          minWidth: 0,
          background: "none",
          border: "none",
          outline: "none",
          color: "var(--text)",
          fontSize: 13,
          fontFamily: "var(--font-mono)",
          padding: 0,
        }}
      />

      {/* Aa — case-sensitive toggle */}
      <Tooltip content={t("Match case")}>
        <button
          onClick={() => onCaseSensitiveChange(!caseSensitive)}
          aria-label={t("Match case")}
          style={{
            padding: "1px 6px",
            fontSize: 11,
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
            background: caseSensitive ? "var(--bg-selected)" : "var(--bg-hover)",
            color: caseSensitive ? "var(--text)" : "var(--text-muted)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            lineHeight: "16px",
          }}
        >
          Aa
        </button>
      </Tooltip>

      {/* Match counter */}
      <span
        style={{
          fontSize: 11,
          color: hasMatches ? "var(--text-dim)" : "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          minWidth: 50,
          textAlign: "right",
          flexShrink: 0,
        }}
      >
        {counterText}
      </span>

      {/* Up arrow — previous match */}
      <Tooltip content={t("Previous match")}>
        <button
          onClick={onPrev}
          disabled={prevDisabled}
          aria-label={t("Previous match")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: prevDisabled ? "var(--text-dim)" : "var(--text-muted)",
            cursor: prevDisabled ? "default" : "pointer",
            flexShrink: 0,
            opacity: prevDisabled ? 0.4 : 1,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
            <polyline
              points="10 4 6 8 10 12"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </Tooltip>

      {/* Down arrow — next match */}
      <Tooltip content={t("Next match")}>
        <button
          onClick={onNext}
          disabled={nextDisabled}
          aria-label={t("Next match")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: nextDisabled ? "var(--text-dim)" : "var(--text-muted)",
            cursor: nextDisabled ? "default" : "pointer",
            flexShrink: 0,
            opacity: nextDisabled ? 0.4 : 1,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
            <polyline
              points="6 4 10 8 6 12"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </Tooltip>

      {/* Close */}
      <Tooltip content={t("Close search")}>
        <button
          onClick={onClose}
          aria-label={t("Close search")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            background: "none",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            flexShrink: 0,
            borderRadius: 4,
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}
