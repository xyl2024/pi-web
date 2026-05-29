"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { SessionSearchResult } from "@/lib/types";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  cwd: string | null;
  onSelectSession: (result: SessionSearchResult) => void;
  t: (key: string) => string;
}

type SearchStatus = "idle" | "loading" | "error" | "no_results";

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
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
    // Text before the marker
    if (markerIdx > 0) {
      parts.push(<span key={key++}>{remaining.slice(0, markerIdx)}</span>);
    }
    remaining = remaining.slice(markerIdx + 1);
    // Find closing marker
    const endIdx = remaining.indexOf("\u0000");
    if (endIdx === -1) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    }
    // Highlighted text
    parts.push(<mark key={key++} className="search-highlight">{remaining.slice(0, endIdx)}</mark>);
    remaining = remaining.slice(endIdx + 1);
  }

  return parts;
}

export function CommandPalette({ open, onClose, cwd, onSelectSession, t }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const resultsContainerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset state when opened/closed
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setHasMore(false);
      setStatus("idle");
      setErrorMessage("");
      setSelectedIndex(0);
      // Focus input after render
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const performSearch = useCallback(async (searchQuery: string) => {
    if (!cwd || !searchQuery.trim()) return;

    // Abort previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus("loading");
    setErrorMessage("");
    setResults([]);
    setSelectedIndex(0);

    try {
      const params = new URLSearchParams({ cwd, q: searchQuery.trim() });
      const res = await fetch(`/api/sessions/search?${params}`, {
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json();
      if (controller.signal.aborted) return;

      setResults(data.results ?? []);
      setHasMore(data.hasMore ?? false);
      setStatus(data.results?.length === 0 ? "no_results" : "idle");
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [cwd]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (status === "idle" || status === "no_results") {
        // If we have results and a valid selection, open it
        if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
          onSelectSession(results[selectedIndex]);
          onClose();
        } else {
          // No results yet — trigger search
          performSearch(query);
        }
      } else if (status === "error") {
        // Retry on error
        performSearch(query);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
  }, [onClose, query, results, selectedIndex, status, performSearch]);

  // Scroll selected item into view
  useEffect(() => {
    if (!resultsContainerRef.current) return;
    const selectedEl = resultsContainerRef.current.querySelector(
      `[data-result-index="${selectedIndex}"]`
    );
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  return createPortal(
    <div
      className="command-palette-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0, 0, 0, 0.35)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
      }}
    >
      <div
        className="command-palette-panel"
        style={{
          width: "min(600px, 90vw)",
          maxHeight: "60vh",
          background: "var(--bg-panel, #1e1e2e)",
          border: "1px solid var(--border, #333)",
          borderRadius: 12,
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Search input */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            borderBottom: "1px solid var(--border, #333)",
          }}
        >
          <svg
            width="16"
            height="16"
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
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("Search sessions...")}
            disabled={!cwd}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              outline: "none",
              color: "var(--text, #e0e0e0)",
              fontSize: 15,
              fontFamily: "inherit",
            }}
          />
          {status === "loading" && (
            <div
              style={{
                width: 16,
                height: 16,
                border: "2px solid var(--border, #333)",
                borderTopColor: "var(--accent, #6c8cff)",
                borderRadius: "50%",
                animation: "spin 0.6s linear infinite",
                flexShrink: 0,
              }}
            />
          )}
          {!cwd && (
            <span style={{ fontSize: 11, color: "var(--text-dim, #666)", flexShrink: 0 }}>
              {t("No workspace selected")}
            </span>
          )}
        </div>

        {/* Results */}
        <div
          ref={resultsContainerRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "8px 0",
          }}
        >
          {status === "no_results" && (
            <div
              style={{
                padding: "32px 16px",
                textAlign: "center",
                color: "var(--text-muted, #888)",
                fontSize: 13,
              }}
            >
              {t("No sessions found matching")} &ldquo;{query}&rdquo;
            </div>
          )}

          {status === "error" && (
            <div
              style={{
                padding: "24px 16px",
                textAlign: "center",
              }}
            >
              <div style={{ color: "var(--danger, #e0556a)", fontSize: 13, marginBottom: 8 }}>
                {errorMessage || t("Search failed")}
              </div>
              <button
                onClick={() => performSearch(query)}
                style={{
                  padding: "6px 14px",
                  background: "var(--bg-hover, #333)",
                  border: "1px solid var(--border, #444)",
                  borderRadius: 6,
                  color: "var(--text, #e0e0e0)",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {t("Retry")}
              </button>
            </div>
          )}

          {results.map((result, idx) => (
            <div
              key={result.id}
              data-result-index={idx}
              onClick={() => {
                onSelectSession(result);
                onClose();
              }}
              onMouseEnter={() => setSelectedIndex(idx)}
              style={{
                padding: "10px 16px",
                cursor: "pointer",
                background: idx === selectedIndex ? "var(--bg-selected, #2a2a3e)" : "transparent",
                transition: "background 0.08s",
                borderLeft: idx === selectedIndex ? "3px solid var(--accent, #6c8cff)" : "3px solid transparent",
              }}
            >
              {/* Row 1: name + matchCount + time */}
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  marginBottom: 3,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text, #e0e0e0)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                  }}
                >
                  {result.name || result.id.slice(0, 8)}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-dim, #666)", whiteSpace: "nowrap" }}>
                  {result.matchCount} {result.matchCount === 1 ? "match" : "matches"}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-dim, #666)", whiteSpace: "nowrap" }}>
                  {formatRelativeTime(result.modified)}
                </span>
              </div>

              {/* Row 2: snippet */}
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

          {hasMore && (
            <div
              style={{
                padding: "10px 16px",
                fontSize: 12,
                color: "var(--text-dim, #666)",
                textAlign: "center",
              }}
            >
              {t("...and more results. Narrow your search.")}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div
          style={{
            display: "flex",
            gap: 16,
            padding: "8px 16px",
            borderTop: "1px solid var(--border, #333)",
            fontSize: 11,
            color: "var(--text-dim, #666)",
          }}
        >
          <span>↑↓ {t("navigate")}</span>
          <span>Enter {t("open")}</span>
          <span>Esc {t("close")}</span>
        </div>
      </div>

      {/* Spinner keyframes */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .search-highlight {
          background: var(--accent, #6c8cff);
          color: #fff;
          border-radius: 2px;
          padding: 0 1px;
        }
      `}</style>
    </div>,
    document.body
  );
}
