"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { Tooltip } from "./Tooltip";

interface Status {
  url: string | null;
  ready: boolean;
  pid: number | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 2000;
const POLL_INTERVAL_ERROR_MS = 3000;

export function PlaywrightDashboardPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>({
    url: null,
    ready: false,
    pid: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await fetch("/api/dashboard/status");
        const next: Status = await res.json();
        if (cancelled) return;
        setStatus(next);
        if (!next.ready) timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_ERROR_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const dotColor = status.ready
    ? "var(--accent)"
    : status.error
      ? "#d44"
      : "#da3";
  const dotTitle = status.error
    ? status.error
    : status.ready
      ? t("Ready")
      : t("Starting");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "6px 10px",
          gap: 8,
          flexShrink: 0,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dotColor,
            display: "inline-block",
            flexShrink: 0,
          }}
          title={dotTitle}
        />
        <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
          {t("Playwright Dashboard")}
        </span>
        {status.url && (
          <Tooltip content={t("Open in new tab")}>
            <a
              href={status.url}
              target="_blank"
              rel="noreferrer"
              style={{
                marginLeft: "auto",
                color: "var(--text-muted)",
                fontSize: 12,
                textDecoration: "none",
              }}
            >
              ↗
            </a>
          </Tooltip>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {status.ready && status.url ? (
          <iframe
            key={status.url}
            src={status.url}
            sandbox="allow-scripts allow-same-origin allow-popups"
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              display: "block",
              background: "#1e1e1e",
            }}
            title="Playwright Dashboard"
          />
        ) : (
          <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12 }}>
            {status.error ?? t("Starting...")}
          </div>
        )}
      </div>
    </div>
  );
}