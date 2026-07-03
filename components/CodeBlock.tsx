"use client";

import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  code: string;
  lang: string;
}

/**
 * Shared syntax-highlighted code block with language label, copy button, and
 * line numbers. Used by MessageView, FileViewer (markdown preview), and
 * TodoDescriptionView so the todo panel renders code blocks the same way as
 * the file viewer.
 */
export function CodeBlock({ code, lang }: Props) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    copyText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Silent — UI just doesn't flip to "Copied". Surface a console hint
        // so debugging is possible without a visible failure.
        console.warn("clipboard write failed");
      });
  };

  return (
    <div
      style={{
        position: "relative",
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
      <div
        style={{
          position: "relative",
          minHeight: 32,
          padding: "0 12px",
          background: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.025)",
          borderBottom: "1px solid var(--border)",
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
            maxWidth: "calc(100% - 120px)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {lang}
        </span>
        <button
          onClick={copy}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 11,
            fontFamily: "var(--font-sans)",
            padding: "2px 6px",
            borderRadius: 4,
          }}
        >
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
      <SyntaxHighlighter
        language={lang || "text"}
        style={isDark ? vscDarkPlus : vs}
        showLineNumbers
        lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
        customStyle={{
          margin: 0,
          padding: "10px 12px",
          fontSize: 12.5,
          lineHeight: 1.6,
          borderRadius: 0,
          background: "var(--bg)",
        }}
        codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

// Best-effort clipboard write. Tries the async Clipboard API first (may
// reject in insecure / unfocused contexts — e.g. HTTP localhost with the
// window blurred) and falls through to the legacy execCommand path. Rejects
// only if both paths fail.
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the execCommand fallback below.
    }
  }
  if (typeof document === "undefined" || !document.body) {
    throw new Error("clipboard unavailable");
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  ta.setAttribute("readonly", "");
  document.body.appendChild(ta);
  const selection = document.getSelection();
  const savedRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  ta.select();
  ta.setSelectionRange(0, text.length);
  // execCommand is deprecated but still the only reliable fallback for
  // non-secure / non-focused contexts where the Clipboard API rejects.
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  if (savedRange && selection) {
    selection.removeAllRanges();
    selection.addRange(savedRange);
  }
  if (!ok) throw new Error("clipboard unavailable");
}
