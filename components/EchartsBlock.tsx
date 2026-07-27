"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as echarts from "echarts";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";

// Dynamic import keeps echarts (~MB) out of the initial bundle — only fetched
// the first time an echarts block actually renders. The module promise is
// memoized so subsequent blocks reuse the same load.
let libPromise: Promise<typeof echarts> | null = null;
function loadLib(): Promise<typeof echarts> {
  if (!libPromise) libPromise = import("echarts");
  return libPromise;
}

// Evaluate the code block as JS that produces an ECharts `option`.
//
// SECURITY: this runs LLM-generated JavaScript via `new Function` (never
// `eval`). pi-web is a local single-user tool and the content originates from
// the user's own assistant session, so the trust boundary is the same as any
// other rendered assistant output. Every evaluation is wrapped in try/catch so
// a malformed option can never take down the surrounding page.
//
// Returns a Promise so the caller can `await` uniformly. The async
// statement-body path wraps the block in an async IIFE, which unlocks
// `await` inside the block — `const data = await fetch(...); option = {
// series: [{ data }] };` renders the chart once the fetch settles.
async function evalOption(code: string, lib: typeof echarts): Promise<unknown> {
  try {
    // Fast path: bare expression — `{ ... }`, `[...]`, an identifier, etc.
    // Parens make an object literal parse as a value, not a block. Stays
    // sync so the common case pays no async IIFE overhead.
    return new Function("echarts", `return (${code})`)(lib);
  } catch {
    // Not a valid expression — fall through to the async statement-body path.
  }
  // Async statement body: the IIFE wrapper lets the user `await`, and the
  // appended `return option` propagates the final value once any awaits
  // settle. `typeof` against an undeclared identifier returns `"undefined"`
  // without throwing, so it's safe even when the block never references
  // `option`.
  return new Function(
    "echarts",
    `return (async () => { ${code}\n;return typeof option !== "undefined" ? option : undefined; })();`,
  )(lib);
}

const CHART_HEIGHT = 400;

interface Props {
  code: string;
  /**
   * When true (parent is mid-stream), suppresses the error banner so partial
   * syntax during streaming doesn't flash "Failed to render" on every token.
   * A complete ```echarts ... ``` block switches to a chart as soon as the
   * last line is written — even if the rest of the message is still streaming.
   */
  isStreaming?: boolean;
}

/**
 * Renders an `echarts` fenced code block as a canvas chart. Used by
 * MessageView, FileViewer, ShowFileRenderer, and TodoDescriptionView to detect
 * ```echarts blocks and replace react-markdown's default `pre > code` fallback
 * with an actual ECharts chart. The block body is JS that evaluates to an
 * ECharts `option` object — either a bare expression (`{ ... }`, `[...]`,
 * etc.) or a statement body that assigns to `option`. Statement bodies may
 * declare helpers above the assignment and don't need a trailing
 * `return option;` — the final value of `option` is returned automatically.
 *
 * `await` is supported: the block body is wrapped in an async IIFE so users
 * can write `const data = await fetch(...); option = { series: [{ data }]
 * };` and have the chart render once the await settles. Until then the
 * block shows a "Rendering…" placeholder.
 */
export function EchartsBlock({ code, isStreaming }: Props) {
  const { t } = useI18n();
  const { preset, isDark } = useTheme();
  const [lib, setLib] = useState<typeof echarts | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"rendered" | "source">("rendered");
  // Eval result is state, not a useMemo, because eval is async — `await`
  // inside the block makes the result a Promise.
  const [option, setOption] = useState<object | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  // One-time load of the echarts lib. The loaded module identity is stable for
  // the lifetime of the page.
  useEffect(() => {
    let cancelled = false;
    loadLib().then((m) => {
      if (!cancelled) setLib(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve the theme background so exported PNGs and the (opaque) chart area
  // match the surrounding UI. `preset` is read so this re-runs on theme change.
  const bg = useMemo(() => {
    void preset;
    if (typeof document === "undefined") return isDark ? "#1a1a1a" : "#ffffff";
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--bg")
      .trim();
    return v || (isDark ? "#1a1a1a" : "#ffffff");
  }, [preset, isDark]);

  // Evaluate the code into an option object whenever `code` or `lib` changes.
  // Reset to `null` first so a previous chart doesn't flash while the new
  // eval settles. The `cancelled` flag discards stale results when `code`
  // changes mid-flight (e.g. fast token stream during streaming).
  useEffect(() => {
    if (!lib) return;
    setOption(null);
    setEvalError(null);
    let cancelled = false;
    evalOption(code, lib)
      .then((opt) => {
        if (cancelled) return;
        if (opt && typeof opt === "object") {
          setOption(opt as object);
        } else {
          setEvalError("Evaluated value is not an ECharts option object");
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setEvalError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [code, lib]);

  // Init / update the chart whenever the option, theme, or view mode changes.
  // echarts binds its theme at init time, so a theme switch means dispose +
  // re-init (cheap; setOption is synchronous).
  useEffect(() => {
    setRenderError(null);
    if (!lib || !option || viewMode !== "rendered") return;
    const el = containerRef.current;
    if (!el) return;
    const chart = lib.init(el, isDark ? "dark" : undefined, { renderer: "canvas" });
    chartRef.current = chart;
    try {
      chart.setOption(option as echarts.EChartsCoreOption);
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : String(e));
    }
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [lib, option, isDark, preset, viewMode]);

  const error = evalError || renderError;

  const onCopy = useCallback(() => {
    void copyToClipboard(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  // Export a PNG via an off-screen chart so download works regardless of the
  // current view mode (in "source" mode the on-screen chart is disposed).
  const onDownload = useCallback(() => {
    if (!lib || !option) return;
    const w = containerRef.current?.clientWidth || 800;
    const off = document.createElement("div");
    off.style.cssText = `position:fixed;left:-99999px;top:0;width:${w}px;height:${CHART_HEIGHT}px`;
    document.body.appendChild(off);
    const chart = lib.init(off, isDark ? "dark" : undefined, { renderer: "canvas" });
    try {
      chart.setOption(option as echarts.EChartsCoreOption);
      const url = chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: bg });
      const a = document.createElement("a");
      a.href = url;
      a.download = "chart.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      // ignore — the on-screen error banner already covers render failures
    } finally {
      chart.dispose();
      off.remove();
    }
  }, [lib, option, isDark, bg]);

  const showChart = viewMode === "rendered" && !!option;

  const body = showChart ? (
    <div style={{ padding: "10px 12px", background: "var(--bg)" }}>
      <div ref={containerRef} style={{ width: "100%", height: CHART_HEIGHT }} />
    </div>
  ) : viewMode === "rendered" ? (
    // Loading / streaming / error placeholder — keeps layout stable and, while
    // streaming, avoids flashing the source or an error on every token.
    <div
      style={{
        height: CHART_HEIGHT,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-dim)",
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        background: "var(--bg)",
      }}
    >
      {t("Rendering…")}
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
        canExpand={!!option}
        onExpand={() => setExpanded(true)}
        onDownload={onDownload}
        onCopy={onCopy}
        copied={copied}
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
          {t("Failed to render ECharts chart")} — {error}
        </div>
      )}
      {expanded && option && lib && (
        <FullscreenOverlay onClose={() => setExpanded(false)}>
          <EchartsFullscreen lib={lib} option={option} isDark={isDark} />
        </FullscreenOverlay>
      )}
    </div>
  );
}

// A second, independent chart instance sized to the fullscreen overlay. Canvas
// charts can't be moved in the DOM the way an SVG can, so we re-init here.
function EchartsFullscreen({
  lib,
  option,
  isDark,
}: {
  lib: typeof echarts;
  option: object;
  isDark: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = lib.init(el, isDark ? "dark" : undefined, { renderer: "canvas" });
    try {
      chart.setOption(option as echarts.EChartsCoreOption);
    } catch {
      // ignore — the inline block already surfaces render errors
    }
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [lib, option, isDark]);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        padding: 24,
        boxSizing: "border-box",
        background: "var(--bg)",
      }}
    >
      <div ref={ref} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

function Header({
  canExpand,
  onExpand,
  onDownload,
  onCopy,
  copied,
  viewMode,
  onToggleView,
}: {
  canExpand: boolean;
  onExpand: () => void;
  onDownload: () => void;
  onCopy: () => void;
  copied: boolean;
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
      <span
        style={{
          position: "absolute",
          left: "50%",
          transform: "translateX(-50%)",
          fontSize: 11,
          color: "var(--text-muted)",
          fontFamily: "var(--font-sans)",
          pointerEvents: "none",
          maxWidth: "calc(100% - 200px)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        echarts
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
          ariaLabel={t("Download PNG")}
          title={t("Download PNG")}
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
        borderRadius: 4,
        fontFamily: "var(--font-mono)",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

// Viewport-sized overlay for chart inspection. Mirrors the pattern in
// MermaidBlock.FullscreenOverlay; kept inlined here to keep the feature
// surface self-contained and avoid cross-component coupling.
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
      <button
        onClick={onClose}
        title={t("Close")}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.28)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.18)";
        }}
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          zIndex: 1,
          width: 36,
          height: 36,
          padding: 0,
          fontSize: 16,
          lineHeight: 1,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(255,255,255,0.18)",
          color: "rgba(255,255,255,0.95)",
          border: "1px solid rgba(255,255,255,0.35)",
          borderRadius: 8,
          fontFamily: "var(--font-mono)",
        }}
      >
        ✕
      </button>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{children}</div>
    </div>
  );
}

// Best-effort clipboard write with a textarea fallback for non-secure
// contexts. Mirrors the inline helper used by MermaidBlock; kept local because
// it has only one consumer.
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
