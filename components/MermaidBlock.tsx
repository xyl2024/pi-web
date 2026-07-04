"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type * as BeautifulMermaid from "beautiful-mermaid";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";

// Dynamic import keeps elkjs (~MB) out of the initial bundle — only fetched
// the first time a mermaid block actually renders. The module promise is
// memoized so subsequent blocks reuse the same load.
let libPromise: Promise<typeof BeautifulMermaid> | null = null;
function loadLib(): Promise<typeof BeautifulMermaid> {
  if (!libPromise) libPromise = import("beautiful-mermaid");
  return libPromise;
}

// Strip the Google Fonts @import that beautiful-mermaid embeds for the chosen
// `font` option. pi-web's own font stack handles typography elsewhere; the
// @import would otherwise trigger a network round-trip on first render and
// makes the rendered SVG non-self-contained when network is restricted.
// The font-family CSS rule is left intact, so the browser falls back through
// the system stack we already load.
const FONT_IMPORT_RE = /@import url\([^)]+\);?\s*/g;

interface Props {
  code: string;
  /**
   * When true (parent is mid-stream), suppresses the error banner so partial
   * syntax during streaming doesn't flash "Failed to render" on every token.
   * The render attempt still runs on every code change, so a complete
   * ```mermaid ... ``` block switches to SVG as soon as the last line is
   * written — even if the rest of the message is still streaming.
   */
  isStreaming?: boolean;
}

/**
 * Renders a `mermaid` fenced code block as an SVG diagram. Used by
 * MessageView, TodoPanel, and FileViewer to detect ```mermaid blocks
 * inside markdown and replace react-markdown's default `pre > code`
 * fallback with an actual diagram.
 */
export function MermaidBlock({ code, isStreaming }: Props) {
  const { t } = useI18n();
  const { preset, isDark } = useTheme();
  const [lib, setLib] = useState<typeof BeautifulMermaid | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [asciiCopied, setAsciiCopied] = useState(false);
  // "rendered" shows the SVG (or the source pre as fallback while loading /
  // on parse error). "source" forces the source pre regardless — useful for
  // copy-paste, comparing syntax against the rendered result, or working
  // around a renderer bug.
  const [viewMode, setViewMode] = useState<"rendered" | "source">("rendered");

  // One-time load of the lib + elkjs. The loaded module identity is stable
  // for the lifetime of the page, so the memo below can depend on it.
  useEffect(() => {
    let cancelled = false;
    loadLib().then((m) => {
      if (!cancelled) setLib(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Read the current theme's CSS variables off :root and pass the resolved
  // color values to the renderer. We do NOT pass `var(--bg)` style references
  // here: the renderer inlines them on the SVG root as `style="--bg:var(--bg)"`
  // and not every browser resolves that self-reference correctly — the result
  // is the literal string "var(--bg)" being used as a color, which falls back
  // to black on the affected elements (e.g. edge-label rects).
  // Depending on `preset` re-reads the variables on theme change, so the
  // diagram re-skins immediately. It's not strictly live like a pure-CSS
  // solution would be, but renderMermaidSVG is synchronous and fast.
  const options = useMemo<BeautifulMermaid.RenderOptions>(() => {
    const fallback = (name: string, def: string) => {
      if (typeof document === "undefined") return def;
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      return v || def;
    };
    // `preset` is read for its side effect of re-running this memo on theme
    // change so the variables are re-resolved against the new theme.
    void preset;
    return {
      bg: fallback("--bg", "#ffffff"),
      fg: fallback("--text", "#1a1a1a"),
      accent: fallback("--accent", "#2563eb"),
      border: fallback("--border", "#e0e0e0"),
      surface: fallback("--bg-panel", "#f5f5f5"),
      muted: fallback("--text-muted", "#6b7280"),
      line: fallback("--border", "#e0e0e0"),
      transparent: true,
      font: "Inter",
    };
  }, [preset]);

  const { svg, error } = useMemo<{ svg: string | null; error: string | null }>(() => {
    if (!lib) return { svg: null, error: null };
    try {
      const raw = lib.renderMermaidSVG(code, options);
      const cleaned = raw.replace(FONT_IMPORT_RE, "");
      return { svg: cleaned, error: null };
    } catch (e) {
      return { svg: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [code, lib, options]);

  const onCopy = useCallback(() => {
    void copyToClipboard(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  // Render the diagram as ASCII/Unicode text and write it to the clipboard.
  // We pick pure ASCII (useAscii: true) + no color codes so the result pastes
  // cleanly into anything — markdown, code comments, terminal, IM. The SVG
  // already proved the source is parseable, so this rarely throws; on the
  // off chance it does, fail silently rather than interrupting the user.
  const onCopyAscii = useCallback(() => {
    if (!lib) return;
    try {
      const ascii = lib.renderMermaidASCII(code, {
        useAscii: true,
        colorMode: "none",
      });
      void copyToClipboard(ascii).then(() => {
        setAsciiCopied(true);
        setTimeout(() => setAsciiCopied(false), 1500);
      });
    } catch {
      // ignore — see comment above
    }
  }, [code, lib]);

  const onDownload = useCallback(() => {
    if (!svg) return;
    // The renderer emits an `<svg>` element without the XML prolog;
    // a prolog makes the file open cleanly in standalone viewers.
    const blob = new Blob(
      ['<?xml version="1.0" encoding="UTF-8"?>\n', svg],
      { type: "image/svg+xml;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "diagram.svg";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [svg]);

  // Body: show the source `<pre>` until the SVG is ready, then keep showing
  // the SVG. Showing the source during the initial mount, while streaming,
  // and after a parse error means the user never sees a "Loading…" flash —
  // the only visible transition is source → SVG, which `minHeight: 80` keeps
  // layout-stable. Errors are surfaced in the red banner below.
  //
  // The body is a two-layer layout: the outer div is the scroll viewport
  // (owns `overflow: auto` so both axes can scroll); the inner div is a flex
  // wrapper with `min-width: min-content` so it never collapses below the
  // SVG's intrinsic width. Without the inner wrapper, `display: flex` on the
  // outer would let the SVG shrink (`flex-shrink: 1`) instead of triggering
  // a horizontal scrollbar when the diagram is wider than the viewport.
  // Source mode (or no SVG yet) falls back to the raw `<pre>` so the user
  // can always see the underlying syntax.
  //
  // `showRendered` is reused inside the JSX below — TypeScript narrows it
  // to `string` in the truthy branch, so we don't need a separate cast.
  const showRendered = viewMode === "rendered" && svg;
  const body = showRendered ? (
    <div
      style={{
        padding: "10px 12px",
        background: "var(--bg)",
        overflow: "auto",
        maxHeight: "60vh",
        minHeight: 80,
      }}
    >
      <div
        dangerouslySetInnerHTML={{ __html: showRendered }}
        style={{
          display: "flex",
          justifyContent: "center",
          minWidth: "min-content",
        }}
      />
    </div>
  ) : (
    <pre
      style={{
        margin: 0,
        padding: "10px 12px",
        fontSize: 12.5,
        lineHeight: 1.6,
        color: "var(--text)",
        fontFamily: "var(--font-mono)",
        whiteSpace: "pre",
        background: "var(--bg)",
        overflow: "auto",
        maxHeight: "60vh",
        minHeight: 80,
      }}
    >
      {code}
    </pre>
  );

  return (
    <div
      style={{
        marginTop: 8,
        marginBottom: 8,
        borderRadius: 10,
        overflow: "hidden",
        border: "1px solid var(--border)",
        background: "var(--bg)",
        boxShadow: isDark
          ? "0 6px 18px rgba(0,0,0,0.35)"
          : "0 4px 14px rgba(0,0,0,0.08)",
      }}
    >
      <Header
        canExpand={!!svg || viewMode === "source"}
        onExpand={() => setExpanded(true)}
        onDownload={onDownload}
        onCopy={onCopy}
        copied={copied}
        onCopyAscii={onCopyAscii}
        asciiCopied={asciiCopied}
        canCopyAscii={!!lib}
        viewMode={viewMode}
        onToggleView={() => setViewMode((m) => (m === "rendered" ? "source" : "rendered"))}
      />
      {body}
      {error && !isStreaming && (
        <div
          style={{
            color: "#f87171",
            fontSize: 11,
            padding: "4px 10px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          {t("Failed to render Mermaid diagram")} — {error}
        </div>
      )}
      {expanded && (
        <FullscreenOverlay onClose={() => setExpanded(false)}>
          {showRendered ? (
            <div
              style={{
                width: "100%",
                height: "100%",
                overflow: "auto",
                padding: 24,
                boxSizing: "border-box",
                background: "var(--bg)",
              }}
            >
              <div
                dangerouslySetInnerHTML={{ __html: showRendered }}
                style={{
                  minWidth: "min-content",
                  minHeight: "min-content",
                  width: "100%",
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              />
            </div>
          ) : (
            <pre
              style={{
                margin: 0,
                padding: 24,
                fontSize: 13,
                lineHeight: 1.6,
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                whiteSpace: "pre",
                background: "var(--bg)",
                width: "100%",
                height: "100%",
                overflow: "auto",
                boxSizing: "border-box",
              }}
            >
              {code}
            </pre>
          )}
        </FullscreenOverlay>
      )}
    </div>
  );
}

function Header({
  canExpand,
  onExpand,
  onDownload,
  onCopy,
  copied,
  onCopyAscii,
  asciiCopied,
  canCopyAscii,
  viewMode,
  onToggleView,
}: {
  canExpand: boolean;
  onExpand: () => void;
  onDownload: () => void;
  onCopy: () => void;
  copied: boolean;
  onCopyAscii: () => void;
  asciiCopied: boolean;
  canCopyAscii: boolean;
  viewMode: "rendered" | "source";
  onToggleView: () => void;
}) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  return (
    <div
      style={{
        position: "relative",
        minHeight: 32,
        padding: "0 12px",
        background: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.025)",
        borderBottom: "1px solid var(--border)",
        fontSize: 11,
        color: "var(--text-dim)",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      {/* macOS traffic-light buttons (decorative) */}
      <span
        aria-hidden
        style={{ display: "inline-flex", gap: 7, alignItems: "center" }}
      >
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f57", boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.15)" }} />
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#febc2e", boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.15)" }} />
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#28c840", boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.15)" }} />
      </span>
      <span
        style={{
          position: "absolute",
          left: "50%",
          transform: "translateX(-50%)",
          fontSize: 11,
          color: "var(--text-muted)",
          fontFamily: "var(--font-sans)",
          pointerEvents: "none",
          maxWidth: "calc(100% - 240px)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        mermaid
      </span>
      <div style={{ display: "flex", gap: 4, alignItems: "center", marginLeft: "auto" }}>
        <HeaderButton
          onClick={onExpand}
          disabled={!canExpand}
          ariaLabel={t("Click to expand")}
          title={t("Click to expand")}
        >
          ⛶
        </HeaderButton>
        <HeaderButton
          onClick={onToggleView}
          ariaLabel={viewMode === "source" ? t("View diagram") : t("View source")}
          title={viewMode === "source" ? t("View diagram") : t("View source")}
        >
          {"</>"}
        </HeaderButton>
        <HeaderButton
          onClick={onDownload}
          disabled={!canExpand}
          ariaLabel={t("Download SVG")}
          title={t("Download SVG")}
        >
          ↓
        </HeaderButton>
        <HeaderButton
          onClick={onCopyAscii}
          disabled={!canCopyAscii}
          ariaLabel={t("Copy as ASCII")}
          title={t("Copy as ASCII")}
        >
          {asciiCopied ? t("copied") : t("ASCII")}
        </HeaderButton>
        <HeaderButton
          onClick={onCopy}
          ariaLabel={t("copy")}
          title={t("copy")}
        >
          {copied ? t("copied") : t("copy")}
        </HeaderButton>
      </div>
    </div>
  );
}

function HeaderButton({
  onClick,
  disabled,
  ariaLabel,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      style={{
        background: "none",
        border: "none",
        color: disabled ? "var(--text-dim)" : "var(--text-muted)",
        cursor: disabled ? "default" : "pointer",
        fontSize: 11,
        padding: "2px 6px",
        borderRadius: 4,
        fontFamily: "var(--font-mono)",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

// Viewport-sized overlay for diagram inspection. Mirrors the pattern in
// ShowFileRenderer.FullscreenOverlay; kept inlined here to keep the
// feature surface self-contained and avoid cross-component coupling.
function FullscreenOverlay({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.92)",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 16px",
          background: "rgba(0, 0, 0, 0.5)",
          color: "rgba(255,255,255,0.9)",
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>mermaid</span>
        <button
          onClick={onClose}
          title={t("Close")}
          style={{
            marginLeft: "auto",
            padding: "4px 10px",
            fontSize: 12,
            cursor: "pointer",
            background: "rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.9)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 5,
            fontFamily: "var(--font-mono)",
            lineHeight: 1.2,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{children}</div>
    </div>
  );
}

// Best-effort clipboard write with a textarea fallback for non-secure
// contexts. Mirrors the inline helper used by MessageView's CodeBlock;
// kept local because it has only one consumer.
function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return Promise.resolve();
  } catch {
    return Promise.reject(new Error("clipboard unavailable"));
  }
}
