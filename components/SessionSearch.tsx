"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { SessionMessageSearchResponse, SessionMessageSearchResult } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  sessionId: string;
  onJumpTo: (entryId: string, leafId: string) => void;
  onResultsChange: (matchedEntryIds: string[], keyword: string) => void;
  onClose: () => void;
  visible: boolean;
}

const MAX_LIST_ITEMS = 10;
const DEBOUNCE_MS = 250;

type SearchStatus = "idle" | "loading" | "error" | "no_results" | "results";

function roleLabel(role: string): string {
  switch (role) {
    case "user": return "You";
    case "assistant": return "AI";
    case "toolResult": return "Tool";
    default: return role;
  }
}

function highlightSnippet(snippet: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = snippet;
  let key = 0;

  while (remaining.length > 0) {
    const markerIdx = remaining.indexOf("\u0000");
    if (markerIdx === -1) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    }
    if (markerIdx > 0) {
      parts.push(<span key={key++}>{remaining.slice(0, markerIdx)}</span>);
    }
    remaining = remaining.slice(markerIdx + 1);
    const endIdx = remaining.indexOf("\u0000");
    if (endIdx === -1) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    }
    parts.push(<mark key={key++} className="session-search-highlight">{remaining.slice(0, endIdx)}</mark>);
    remaining = remaining.slice(endIdx + 1);
  }

  return parts;
}

export function SessionSearch({ sessionId, onJumpTo, onResultsChange, onClose, visible }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionMessageSearchResult[]>([]);
  const [matchedEntryIds, setMatchedEntryIds] = useState<string[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasResultsRef = useRef(false);

  // Focus input when opened
  useEffect(() => {
    if (visible) {
      setQuery("");
      setResults([]);
      setMatchedEntryIds([]);
      setTotalMatches(0);
      setStatus("idle");
      setErrorMessage("");
      setSelectedIndex(0);
      hasResultsRef.current = false;
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [visible]);

  // Cleanup debounce + abort on unmount
  useEffect(() => {
    return () => {
      debounceRef.current && clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const performSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setStatus("idle");
      setResults([]);
      setMatchedEntryIds([]);
      setTotalMatches(0);
      hasResultsRef.current = false;
      onResultsChange([], "");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus("loading");
    setErrorMessage("");

    try {
      const params = new URLSearchParams({ q: q.trim() });
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/search?${params}`,
        { signal: controller.signal },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const data: SessionMessageSearchResponse = await res.json();
      if (controller.signal.aborted) return;

      setResults(data.results);
      setMatchedEntryIds(data.matchedEntryIds);
      setTotalMatches(data.totalMatches);
      setSelectedIndex(0);
      setStatus(data.totalMatches === 0 ? "no_results" : "results");
      hasResultsRef.current = data.totalMatches > 0;
      onResultsChange(data.matchedEntryIds, q.trim());
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId, onResultsChange]);

  const handleInputChange = useCallback((value: string) => {
    setQuery(value);
    debounceRef.current && clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => performSearch(value), DEBOUNCE_MS);
  }, [performSearch]);

  const handleJumpTo = useCallback((result: SessionMessageSearchResult) => {
    onJumpTo(result.entryId, result.leafId);
  }, [onJumpTo]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) {
        setQuery("");
        handleInputChange("");
      } else {
        onClose();
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
        handleJumpTo(results[selectedIndex]);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, Math.min(results.length, MAX_LIST_ITEMS) - 1));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
  }, [query, handleInputChange, results, selectedIndex, handleJumpTo, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector(`[data-search-index="${selectedIndex}"]`);
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Notify parent of cleared results when query becomes empty
  useEffect(() => {
    if (!query && hasResultsRef.current) {
      hasResultsRef.current = false;
      setResults([]);
      setMatchedEntryIds([]);
      setTotalMatches(0);
      setStatus("idle");
      onResultsChange([], "");
    }
  }, [query, onResultsChange]);

  if (!visible) return null;

  const displayedResults = results.slice(0, MAX_LIST_ITEMS);

  return (
    <div
      className="session-search-bar"
      style={{
        flexShrink: 0,
        borderBottom: "1px solid var(--border, #333)",
        background: "var(--bg-panel, #1a1a2e)",
      }}
    >
      {/* Search input row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 16px",
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-muted, #888)"
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
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("Search messages...")}
          style={{
            flex: 1,
            background: "none",
            border: "none",
            outline: "none",
            color: "var(--text, #e0e0e0)",
            fontSize: 13,
            fontFamily: "inherit",
          }}
        />
        {/* Match count */}
        {status === "results" && (
          <span style={{ fontSize: 11, color: "var(--text-dim, #666)", flexShrink: 0 }}>
            {selectedIndex + 1}/{totalMatches}
          </span>
        )}
        {/* Navigation arrows */}
        {status === "results" && totalMatches > 1 && (
          <>
            <button
              onClick={() => setSelectedIndex((prev) => Math.max(prev - 1, 0))}
              disabled={selectedIndex === 0}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                background: "none",
                border: "1px solid var(--border, #444)",
                borderRadius: 4,
                color: selectedIndex === 0 ? "var(--text-dim, #444)" : "var(--text-muted, #888)",
                cursor: selectedIndex === 0 ? "default" : "pointer",
                flexShrink: 0,
                opacity: selectedIndex === 0 ? 0.4 : 1,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <polyline points="10 4 6 8 10 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              onClick={() => setSelectedIndex((prev) => Math.min(prev + 1, Math.min(results.length, MAX_LIST_ITEMS) - 1))}
              disabled={selectedIndex >= Math.min(results.length, MAX_LIST_ITEMS) - 1}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                background: "none",
                border: "1px solid var(--border, #444)",
                borderRadius: 4,
                color: selectedIndex >= Math.min(results.length, MAX_LIST_ITEMS) - 1 ? "var(--text-dim, #444)" : "var(--text-muted, #888)",
                cursor: selectedIndex >= Math.min(results.length, MAX_LIST_ITEMS) - 1 ? "default" : "pointer",
                flexShrink: 0,
                opacity: selectedIndex >= Math.min(results.length, MAX_LIST_ITEMS) - 1 ? 0.4 : 1,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <polyline points="6 4 10 8 6 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </>
        )}
        {/* Loading spinner */}
        {status === "loading" && (
          <div
            style={{
              width: 14,
              height: 14,
              border: "2px solid var(--border, #333)",
              borderTopColor: "var(--accent, #6c8cff)",
              borderRadius: "50%",
              animation: "spin 0.6s linear infinite",
              flexShrink: 0,
            }}
          />
        )}
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            background: "none",
            border: "none",
            color: "var(--text-dim, #666)",
            cursor: "pointer",
            flexShrink: 0,
            borderRadius: 4,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Results list */}
      {(status === "results" || status === "no_results" || status === "error") && (
        <div
          ref={listRef}
          style={{
            maxHeight: 240,
            overflowY: "auto",
            borderTop: "1px solid var(--border, #333)",
          }}
        >
          {status === "no_results" && (
            <div
              style={{
                padding: "20px 16px",
                textAlign: "center",
                color: "var(--text-muted, #888)",
                fontSize: 13,
              }}
            >
              {t("No messages found matching")} &ldquo;{query}&rdquo;
            </div>
          )}

          {status === "error" && (
            <div style={{ padding: "16px", textAlign: "center" }}>
              <div style={{ color: "var(--danger, #e0556a)", fontSize: 12, marginBottom: 8 }}>
                {errorMessage}
              </div>
              <button
                onClick={() => performSearch(query)}
                style={{
                  padding: "4px 12px",
                  background: "var(--bg-hover, #333)",
                  border: "1px solid var(--border, #444)",
                  borderRadius: 4,
                  color: "var(--text, #e0e0e0)",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                {t("Retry")}
              </button>
            </div>
          )}

          {displayedResults.map((result, idx) => (
            <div
              key={result.entryId}
              data-search-index={idx}
              onClick={() => handleJumpTo(result)}
              onMouseEnter={() => setSelectedIndex(idx)}
              style={{
                padding: "8px 16px",
                cursor: "pointer",
                background: idx === selectedIndex ? "var(--bg-selected, #2a2a3e)" : "transparent",
                borderLeft: idx === selectedIndex ? "3px solid var(--accent, #6c8cff)" : "3px solid transparent",
                transition: "background 0.08s",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginBottom: 2,
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.03em",
                    padding: "1px 5px",
                    borderRadius: 3,
                    background:
                      result.role === "user" ? "rgba(59,130,246,0.15)" :
                      result.role === "assistant" ? "rgba(139,92,246,0.15)" :
                      "rgba(34,197,94,0.15)",
                    color:
                      result.role === "user" ? "var(--accent, #6c8cff)" :
                      result.role === "assistant" ? "#a78bfa" :
                      "#4ade80",
                  }}
                >
                  {roleLabel(result.role)}
                </span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-muted, #888)",
                  lineHeight: 1.4,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {highlightSnippet(result.snippet)}
              </div>
            </div>
          ))}

          {totalMatches > MAX_LIST_ITEMS && (
            <div
              style={{
                padding: "8px 16px",
                fontSize: 11,
                color: "var(--text-dim, #666)",
                textAlign: "center",
              }}
            >
              +{totalMatches - MAX_LIST_ITEMS} {t("more")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
