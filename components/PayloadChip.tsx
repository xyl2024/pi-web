"use client";

import { useState } from "react";
import { Tooltip } from "./Tooltip";
import { useI18n } from "@/hooks/useI18n";
import { PayloadPopover, type CapturedPayloadSummary } from "./PayloadPopover";

interface Props {
  sessionId: string;
  entryId: string;
  /** True while the provider response hasn't returned yet (still streaming). */
  pending?: boolean;
}

/**
 * Inline status + duration chip rendered next to the model name on each
 * assistant message. Click toggles a popover that shows the full captured
 * provider request / response.
 *
 * Render policy:
 *  - Pending (provider response not yet received): muted "API · 请求中…".
 *  - Loaded: status badge + duration chip, color-coded by HTTP status.
 *
 * State progression: the chip starts in `pending`-style rendering until
 * either the popover is opened and a successful fetch lands, OR until a
 * streaming response completes (caller passes `pending=false`).
 *
 * Cold-session behavior: the chip is always rendered; if the popover's
 * fetch returns 404, the popover shows a "no payload" empty state.
 */
export function PayloadChip({ sessionId, entryId, pending }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [summary, setSummary] = useState<CapturedPayloadSummary | null>(null);

  const showLoaded = !pending && summary !== null;
  const statusColor = summary ? statusToColor(summary.status) : undefined;

  return (
    <>
      <Tooltip content={t("View API request for this response")}>
        <button
          ref={setAnchor}
          onClick={() => setOpen((v) => !v)}
          aria-label={t("View API request for this response")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "1px 6px",
            height: 18,
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-muted)",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
            opacity: 0.75,
            transition: "opacity 0.12s, color 0.12s, border-color 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "1";
            e.currentTarget.style.color = "var(--text)";
            e.currentTarget.style.borderColor = "var(--text-muted)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "0.75";
            e.currentTarget.style.color = "var(--text-muted)";
            e.currentTarget.style.borderColor = "var(--border)";
          }}
        >
          {showLoaded ? (
            <>
              <span
                style={{
                  padding: "0 4px",
                  borderRadius: 3,
                  background: statusColor,
                  color: "#0b0b0b",
                  fontWeight: 600,
                }}
              >
                {summary!.status ?? "—"}
              </span>
              <span style={{ color: "var(--text-dim)" }}>·</span>
              <span style={{ color: "var(--text-muted)" }}>{formatDuration(summary!.durationMs)}</span>
            </>
          ) : (
            <>
              <span style={{ color: "var(--text-dim)" }}>API</span>
              <span style={{ color: "var(--text-dim)" }}>·</span>
              <span style={{ color: "var(--text-muted)" }}>{pending ? t("API request pending") : "req"}</span>
            </>
          )}
        </button>
      </Tooltip>
      {open && anchor && (
        <PayloadPopover
          sessionId={sessionId}
          entryId={entryId}
          anchorEl={anchor}
          onClose={() => setOpen(false)}
          onLoaded={(s) => setSummary(s)}
        />
      )}
    </>
  );
}

function statusToColor(status: number | null | undefined): string {
  if (status === null || status === undefined) return "var(--text-dim)";
  if (status >= 500) return "rgba(248,113,113,0.85)";
  if (status >= 400) return "rgba(248,113,113,0.7)";
  if (status >= 300) return "rgba(234,179,8,0.85)";
  return "rgba(74,222,128,0.85)";
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}
