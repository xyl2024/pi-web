"use client";

import { useI18n } from "@/hooks/useI18n";
import type { ToolCallStatsSnapshot, PerToolStat, WaterfallEntry } from "@/hooks/useToolCallStats";

// ── Props ──

interface Props {
  snapshot: ToolCallStatsSnapshot;
  open: boolean;
  onToggle: () => void;
  /** Summary string shown on the toggle button, e.g. "3 running · 12 total" */
  runningSummary?: string;
  /** Scroll the chat to the message containing this tool call */
  onScrollToToolCall?: (toolCallId: string) => void;
}

// ── Component ──

export function ToolCallStatsDrawer({ snapshot, open, onToggle, runningSummary, onScrollToToolCall }: Props) {
  const { t } = useI18n();
  const { toolStats, waterfall, totalCount, runningCount } = snapshot;

  // ── Derived ──
  const toolEntries: { name: string; stat: PerToolStat }[] = [];
  toolStats.forEach((stat, name) => toolEntries.push({ name, stat }));
  toolEntries.sort((a, b) => b.stat.count - a.stat.count);

  const totalSuccess = toolEntries.reduce((s, t) => s + t.stat.successCount, 0);
  const totalErrors = toolEntries.reduce((s, t) => s + t.stat.errorCount, 0);
  const totalFinished = totalSuccess + totalErrors;
  const successRate = totalFinished > 0 ? Math.round((totalSuccess / totalFinished) * 100) : null;

  const avgDuration = totalFinished > 0
    ? toolEntries.reduce((s, t) => s + t.stat.totalDurationMs, 0) / totalFinished
    : null;

  // Waterfall scale: find min/max timestamps
  const times = waterfall.flatMap((e) => [e.startTime, e.endTime].filter((t): t is number => t != null));
  const tMin = times.length > 0 ? Math.min(...times) : 0;
  const tMax = times.length > 0 ? Math.max(...times) : tMin + 1;
  const totalSpan = tMax - tMin || 1;

  // ── Render ──

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={onToggle}
        title={t("Tool call statistics")}
        style={{
          position: "absolute",
          top: 12,
          right: open ? 328 : 12,
          zIndex: 20,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: open ? "var(--bg-panel)" : "var(--bg-subtle)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          transition: "right 0.2s ease",
        }}
      >
        {/* Bar chart icon */}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <line x1="2" y1="12" x2="2" y2="7" />
          <line x1="6" y1="12" x2="6" y2="4" />
          <line x1="10" y1="12" x2="10" y2="2" />
          <line x1="0.5" y1="12.5" x2="13.5" y2="12.5" />
        </svg>
        {runningSummary && (
          <span style={{ color: runningCount > 0 ? "var(--accent)" : "var(--text-dim)" }}>
            {runningSummary}
          </span>
        )}
      </button>

      {/* Drawer panel */}
      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: 320,
          zIndex: 15,
          background: "var(--bg-panel)",
          borderLeft: "1px solid var(--border)",
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.2s ease",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 14px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
            {t("Tool Calls")}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {t("{n} total").replace("{n}", String(totalCount))}
          </span>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 14 }}>

          {/* ── Summary bar ── */}
          {totalCount > 0 && (
            <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
              <SummaryItem label={t("Success")} value={totalSuccess} color="#16a34a" />
              <SummaryItem label={t("Errors")} value={totalErrors} color="#f87171" />
              {successRate !== null && (
                <SummaryItem label={t("Rate")} value={`${successRate}%`} color={successRate >= 90 ? "#16a34a" : successRate >= 50 ? "#f59e0b" : "#f87171"} />
              )}
              {runningCount > 0 && (
                <SummaryItem label={t("Running")} value={runningCount} color="var(--accent)" />
              )}
              {avgDuration !== null && (
                <SummaryItem label={t("Avg")} value={formatMs(avgDuration)} color="var(--text-dim)" />
              )}
            </div>
          )}

          {/* ── Per-tool table ── */}
          {toolEntries.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {t("By Tool")}
              </div>
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: "var(--text-dim)", fontSize: 11 }}>
                    <th style={{ textAlign: "left", padding: "2px 4px", fontWeight: 500 }}>{t("Tool")}</th>
                    <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 500 }}>{t("#")}</th>
                    <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 500 }}>{t("OK")}</th>
                    <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 500 }}>{t("Err")}</th>
                    <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 500 }}>{t("Avg")}</th>
                  </tr>
                </thead>
                <tbody>
                  {toolEntries.map(({ name, stat }) => (
                    <tr key={name} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                      <td style={{ padding: "3px 4px", fontFamily: "var(--font-mono)", fontSize: 11, color: "#16a34a" }}>
                        {name}
                      </td>
                      <td style={{ padding: "3px 4px", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>
                        {stat.count}
                      </td>
                      <td style={{ padding: "3px 4px", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 11, color: "#16a34a" }}>
                        {stat.successCount}
                      </td>
                      <td style={{ padding: "3px 4px", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 11, color: stat.errorCount > 0 ? "#f87171" : "var(--text-dim)" }}>
                        {stat.errorCount}
                      </td>
                      <td style={{ padding: "3px 4px", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>
                        {stat.count > 0 ? formatMs(stat.totalDurationMs / stat.count) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Waterfall timeline ── */}
          {waterfall.length > 0 && (
            <div style={{ flex: 1, minHeight: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {t("Timeline")}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {waterfall.map((entry) => (
                  <WaterfallRow key={entry.toolCallId} entry={entry} tMin={tMin} totalSpan={totalSpan} onClick={onScrollToToolCall} />
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {totalCount === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center", padding: "20px 0" }}>
              {t("No tool calls yet")}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Sub-components ──

function SummaryItem({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
      <span style={{ fontWeight: 600, color, fontFamily: "var(--font-mono)" }}>{value}</span>
      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{label}</span>
    </div>
  );
}

function WaterfallRow({ entry, tMin, totalSpan, onClick }: { entry: WaterfallEntry; tMin: number; totalSpan: number; onClick?: (toolCallId: string) => void }) {
  const leftPct = ((entry.startTime - tMin) / totalSpan) * 100;
  const endTime = entry.endTime ?? Date.now();
  const widthPct = Math.max(((endTime - entry.startTime) / totalSpan) * 100, 1);
  const isRunning = entry.endTime == null;
  const isError = entry.isError === true;

  let bg = "#16a34a";
  if (isRunning) bg = "var(--text-dim)";
  else if (isError) bg = "#f87171";

  const durationMs = endTime - entry.startTime;

  return (
    <div
      onClick={() => onClick?.(entry.toolCallId)}
      style={{
        position: "relative",
        height: 28,
        cursor: onClick ? "pointer" : undefined,
        borderRadius: 4,
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => { if (onClick) (e.currentTarget as HTMLElement).style.background = "var(--bg-subtle)"; }}
      onMouseLeave={(e) => { if (onClick) (e.currentTarget as HTMLElement).style.background = ""; }}
    >
      {/* Text above bar — never overlaps with colored blocks */}
      <span
        style={{
          position: "absolute",
          top: 0,
          left: `calc(${leftPct}% + 4px)`,
          right: 4,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: "var(--text)",
          lineHeight: "12px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {entry.toolName}
        <span style={{ marginLeft: 4, color: "var(--text-dim)" }}>{formatMs(durationMs)}</span>
      </span>
      {/* Bar below text */}
      <div
        style={{
          position: "absolute",
          top: 14,
          left: `${leftPct}%`,
          width: `${widthPct}%`,
          minWidth: 3,
          height: 12,
          borderRadius: 3,
          background: bg,
          opacity: isRunning ? 0.5 : 0.85,
        }}
      />
    </div>
  );
}

// ── Helpers ──

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
