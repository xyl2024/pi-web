"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { PendingPermissionRequest, Decision } from "@/hooks/usePendingPermissions";

interface Props {
  request: PendingPermissionRequest;
  onDecide: (decision: Decision) => void;
}

const COMMAND_PREVIEW_MAX = 600;

export function PermissionDialog({ request, onDecide }: Props) {
  const { t } = useI18n();
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalEl(document.body);
  }, []);

  // Esc = deny (safe default), Enter = allow once (single key permits the immediate call).
  // 'Allow similar this session' is intentionally mouse-only to avoid accidental over-grant.
  useEffect(() => {
    if (!portalEl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDecide("deny");
      } else if (e.key === "Enter") {
        e.preventDefault();
        onDecide("allow_once");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [portalEl, onDecide]);

  const truncated = request.command.length > COMMAND_PREVIEW_MAX;
  const commandText = truncated
    ? request.command.slice(0, COMMAND_PREVIEW_MAX) + "\n…"
    : request.command;

  if (!portalEl) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // Backdrop click denies (safe default).
        if (e.target === e.currentTarget) onDecide("deny");
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10001,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 20,
          minWidth: 360,
          maxWidth: 560,
          boxShadow: "0 12px 32px rgba(0,0,0,0.42)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
          {t("Permission required")}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("Rule: {name}").replace("{name}", request.ruleName)}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("Agent wants to run a potentially dangerous command:")}
        </div>
        <pre
          style={{
            background: "var(--bg-subtle)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: 10,
            margin: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--text)",
            maxHeight: 220,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {commandText}
        </pre>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          <button
            onClick={() => onDecide("deny")}
            style={{
              padding: "6px 14px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("Deny")}
          </button>
          <button
            onClick={() => onDecide("allow_similar")}
            style={{
              padding: "6px 14px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("Allow similar for this session")}
          </button>
          <button
            autoFocus
            onClick={() => onDecide("allow_once")}
            style={{
              padding: "6px 14px",
              background: "var(--accent)",
              border: "1px solid var(--accent)",
              borderRadius: 4,
              color: "var(--bg)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {t("Allow once")}
          </button>
        </div>
      </div>
    </div>,
    portalEl
  );
}