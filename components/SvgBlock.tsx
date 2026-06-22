"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import DOMPurify from "isomorphic-dompurify";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  code: string;
  /**
   * When true (parent is mid-stream), suppresses error display so partial
   * SVG during streaming doesn't flash "Failed to render" on every token.
   * The render attempt still runs on every code change, so a complete
   * block switches to the rendered view as soon as the closing </svg>
   * tag is written — even if the rest of the message is still streaming.
   */
  isStreaming?: boolean;
}

// Match a real <svg> element opener, not just the substring "svg". Whitespace
// OR ">" must follow the tag name so that `<svg>` and `<svg foo="bar">` both
// qualify but `<svgfoo>` (not real SVG) does not.
const SVG_TAG_RE = /<svg[\s>]/i;

/**
 * Renders a `svg` fenced code block as an inline SVG image. Used wherever
 * MessageView, TodoDescriptionView, FileViewer, or ShowFileRenderer detect
 * ```svg blocks inside markdown and want to replace react-markdown's
 * default `pre > code` fallback with an actual image.
 *
 * The SVG string is sanitized through DOMPurify's built-in SVG profile
 * before injection via dangerouslySetInnerHTML. That profile strips
 * `<script>`, event handlers, `javascript:` URLs, and other active content
 * while preserving the SVG element + attribute set — so a hostile SVG
 * cannot execute JS in the pi-web page context.
 *
 * If the sanitized output doesn't contain an `<svg>` element (invalid
 * markup, empty block, comments-only, host of active content that DOMPurify
 * removed entirely) we fall through to the raw source view so the user
 * can still see what was written.
 */
export function SvgBlock({ code, isStreaming }: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<"rendered" | "source">("rendered");
  const [expanded, setExpanded] = useState(false);

  const { svg, error } = useMemo<{ svg: string | null; error: string | null }>(() => {
    try {
      const cleaned = DOMPurify.sanitize(code, {
        USE_PROFILES: { svg: true, svgFilters: true },
      });
      if (!cleaned || !SVG_TAG_RE.test(cleaned)) {
        return { svg: null, error: null };
      }
      return { svg: cleaned, error: null };
    } catch (e) {
      return { svg: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [code]);

  const onCopy = useCallback(() => {
    void copyToClipboard(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  const onDownload = useCallback(() => {
    if (!svg) return;
    // The sanitized SVG is emitted without an XML prolog; a prolog makes
    // the file open cleanly in standalone viewers.
    const blob = new Blob(
      ['<?xml version="1.0" encoding="UTF-8"?>\n', svg],
      { type: "image/svg+xml;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "image.svg";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [svg]);

  // Body swap mirrors MermaidBlock: show the sanitized SVG when in rendered
  // mode and sanitization produced an `<svg>` element; otherwise show the
  // raw source. The outer scroll viewport owns `overflow: auto` so both
  // axes can scroll; the inner wrapper enforces `max-width: 100%` so wide
  // diagrams scale down rather than forcing horizontal scroll on narrow
  // viewports (the SVG's own viewBox / preserveAspectRatio governs
  // proportions).
  const showRendered = viewMode === "rendered" && svg;
  const body = showRendered ? (
    <div
      style={{
        padding: "10px 12px",
        background: "var(--bg)",
        overflow: "auto",
        maxHeight: "60vh",
        minHeight: 80,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        dangerouslySetInnerHTML={{ __html: svg }}
        style={{ maxWidth: "100%" }}
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
        marginTop: 4,
        marginBottom: 4,
        borderRadius: 6,
        overflow: "hidden",
        border: "1px solid var(--border)",
      }}
    >
      <Header
        onExpand={() => setExpanded(true)}
        canExpand={!!svg}
        onDownload={onDownload}
        onCopy={onCopy}
        copied={copied}
        viewMode={viewMode}
        canRender={!!svg}
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
          {t("Failed to render SVG")} — {error}
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
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div
                dangerouslySetInnerHTML={{ __html: svg }}
                style={{ maxWidth: "100%", minWidth: "min-content" }}
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
  onExpand,
  canExpand,
  onDownload,
  onCopy,
  copied,
  viewMode,
  canRender,
  onToggleView,
}: {
  onExpand: () => void;
  canExpand: boolean;
  onDownload: () => void;
  onCopy: () => void;
  copied: boolean;
  viewMode: "rendered" | "source";
  canRender: boolean;
  onToggleView: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        padding: "3px 10px",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        fontSize: 11,
        color: "var(--text-dim)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span>svg</span>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
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
          disabled={!canRender}
          ariaLabel={viewMode === "source" ? t("View diagram") : t("View source")}
          title={viewMode === "source" ? t("View diagram") : t("View source")}
        >
          {"</>"}
        </HeaderButton>
        <HeaderButton
          onClick={onDownload}
          disabled={!canRender}
          ariaLabel={t("Download SVG")}
          title={t("Download SVG")}
        >
          ↓
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
        borderRadius: 3,
        fontFamily: "var(--font-mono)",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

// Viewport-sized overlay for fullscreen SVG inspection. Mirrors the
// pattern in MermaidBlock; kept inlined here so the feature surface is
// self-contained and avoids cross-component coupling.
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
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>svg</span>
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
// contexts. Mirrors the inline helper used by MermaidBlock; kept local
// because SvgBlock is its only consumer.
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
