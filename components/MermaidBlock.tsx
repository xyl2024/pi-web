"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";

// Module-level init guard: re-init only when the theme name changes.
// Mermaid has no live theme switch, so the next render call after a theme
// flip will simply pull the new config into effect.
let mermaidInitedFor: string | null = null;
async function ensureMermaid(theme: "default" | "dark"): Promise<typeof import("mermaid").default> {
  if (mermaidInitedFor !== theme) {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      theme,
      securityLevel: "strict",
      fontFamily: "var(--font-mono)",
    });
    mermaidInitedFor = theme;
  }
  return (await import("mermaid")).default;
}

interface Props {
  code: string;
  /**
   * When true (parent is mid-stream), skip Mermaid parsing and just render
   * the raw source. Prevents per-token jank and dozens of intermediate
   * parse-error states on partial syntax.
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
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Track the last code string that successfully produced an SVG. This
  // makes the parse truly idempotent: if the effect re-runs for any
  // reason (e.g. parent re-renders that pass the same code reference,
  // or a dep that's technically stable but causes the effect to fire
  // once more) we skip the parse and avoid clearing the displayed SVG.
  const parsedCodeRef = useRef<string | null>(null);

  // useEffect: render once per code change, but skip while streaming.
  // Cleanup sets `cancelled` so a late `mermaid.render` response can't
  // stomp on a newer render.
  useEffect(() => {
    if (isStreaming) {
      setSvg(null);
      setError(null);
      parsedCodeRef.current = null;
      return;
    }
    if (parsedCodeRef.current === code) {
      return;
    }
    let cancelled = false;
    setError(null);
    setSvg(null);
    const theme: "default" | "dark" = isDark ? "dark" : "default";
    ensureMermaid(theme)
      .then(async (mermaid) => {
        const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
        const { svg: rendered } = await mermaid.render(id, code);
        if (cancelled) return;
        parsedCodeRef.current = code;
        setSvg(rendered);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [code, isDark, isStreaming]);

  const onCopy = useCallback(() => {
    void copyToClipboard(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  const onDownload = useCallback(() => {
    if (!svg) return;
    // Mermaid's render() emits an `<svg>` element without the XML prolog;
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

  // Body priority once an SVG exists: keep showing it. The diagram is
  // expensive to parse and the container has a `min-height` so the
  // surrounding page doesn't reflow if the SVG is briefly absent.
  // Errors are surfaced in the red banner below; streaming falls back
  // to the source `<pre>` until the parse completes.
  const showSource = !svg && (error || isStreaming);
  const body = showSource ? (
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
  ) : svg ? (
    <div
      dangerouslySetInnerHTML={{ __html: svg }}
      style={{
        padding: "10px 12px",
        display: "flex",
        justifyContent: "center",
        background: "var(--bg)",
        overflow: "auto",
        maxHeight: "60vh",
        minHeight: 80,
      }}
    />
  ) : (
    <div
      style={{
        padding: "10px 12px",
        color: "var(--text-dim)",
        fontSize: 12,
        background: "var(--bg)",
        minHeight: 80,
      }}
    >
      {t("Loading…")}
    </div>
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
        canExpand={!showSource}
        onExpand={() => setExpanded(true)}
        onDownload={onDownload}
        onCopy={onCopy}
        copied={copied}
      />
      {body}
      {error && (
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
      {expanded && svg && (
        <FullscreenOverlay onClose={() => setExpanded(false)}>
          <div
            dangerouslySetInnerHTML={{ __html: svg }}
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              boxSizing: "border-box",
              overflow: "auto",
            }}
          />
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
}: {
  canExpand: boolean;
  onExpand: () => void;
  onDownload: () => void;
  onCopy: () => void;
  copied: boolean;
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
      <span>mermaid</span>
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
          onClick={onDownload}
          disabled={!canExpand}
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
