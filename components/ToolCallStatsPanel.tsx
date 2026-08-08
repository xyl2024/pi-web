"use client";

import { useMemo, useState } from "react";
import type * as echarts from "echarts";
import { useI18n } from "@/hooks/useI18n";
import { EchartsChart } from "@/components/EchartsChart";
import { Tooltip } from "@/components/Tooltip";
import type { ToolCallStatsSnapshot, BashRecord, PerToolStat } from "@/hooks/useToolCallStats";

// ── Props ──

interface Props {
  snapshot: ToolCallStatsSnapshot;
  /** Scroll the chat to the message containing this tool call */
  onScrollToToolCall?: (toolCallId: string) => void;
}

// ── Constants ──

const COLOR_OK = "#16a34a";
const COLOR_ERR = "#f87171";
const COLOR_ACCENT = "#3b82f6";
const PIE_TOP_N = 6;
const BASH_PREVIEW_LIMIT = 20;

// ── Component ──

export function ToolCallStatsPanel({ snapshot, onScrollToToolCall }: Props) {
  const { t } = useI18n();
  const { toolStats, bashRecords, totalCount, runningCount } = snapshot;

  // ── Derived ──
  const toolEntries = useMemo<{ name: string; stat: PerToolStat }[]>(() => {
    const arr: { name: string; stat: PerToolStat }[] = [];
    toolStats.forEach((stat, name) => arr.push({ name, stat }));
    arr.sort((a, b) => b.stat.count - a.stat.count);
    return arr;
  }, [toolStats]);

  const totalSuccess = toolEntries.reduce((s, e) => s + e.stat.successCount, 0);
  const totalErrors = toolEntries.reduce((s, e) => s + e.stat.errorCount, 0);
  const totalFinished = totalSuccess + totalErrors;
  const successRate = totalFinished > 0 ? Math.round((totalSuccess / totalFinished) * 100) : null;

  // ── Overview chart options ──
  const pieOption = useMemo<echarts.EChartsCoreOption | null>(() => {
    if (toolEntries.length === 0) return null;
    // Top N + "Other" when there are many tools — keeps the donut readable.
    const top = toolEntries.slice(0, PIE_TOP_N);
    const overflowCount = toolEntries.length - top.length;
    const overflowSum = overflowCount > 0
      ? toolEntries.slice(PIE_TOP_N).reduce((s, e) => s + e.stat.count, 0)
      : 0;
    const data = top.map(({ name, stat }) => ({ name, value: stat.count }));
    if (overflowCount > 0 && overflowSum > 0) {
      data.push({ name: "Other", value: overflowSum });
    }
    return {
      tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
      legend: { show: false },
      series: [
        {
          type: "pie",
          radius: ["48%", "72%"],
          avoidLabelOverlap: true,
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderColor: "transparent", borderWidth: 0 },
          data,
        },
      ],
    };
  }, [toolEntries]);

  const barOption = useMemo<echarts.EChartsCoreOption | null>(() => {
    if (toolEntries.length === 0) return null;
    const names = toolEntries.map((e) => e.name);
    const okData = toolEntries.map((e) => e.stat.successCount);
    const errData = toolEntries.map((e) => e.stat.errorCount);
    return {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: {
        data: [t("OK"), t("Err")],
        bottom: 0,
        textStyle: { fontSize: 10 },
        itemWidth: 10,
        itemHeight: 10,
      },
      grid: { left: 8, right: 16, top: 16, bottom: 32, containLabel: true },
      xAxis: { type: "value", axisLabel: { fontSize: 10 } },
      yAxis: { type: "category", data: names, axisLabel: { fontSize: 10 } },
      series: [
        {
          name: t("OK"),
          type: "bar",
          stack: "total",
          data: okData,
          itemStyle: { color: COLOR_OK },
          emphasis: { focus: "series" },
        },
        {
          name: t("Err"),
          type: "bar",
          stack: "total",
          data: errData,
          itemStyle: { color: COLOR_ERR },
          emphasis: { focus: "series" },
        },
      ],
    };
  }, [toolEntries, t]);

  // ── Bash analysis ──
  const prefixStats = useMemo(() => buildPrefixStats(bashRecords), [bashRecords]);
  const bashBarOption = useMemo<echarts.EChartsCoreOption | null>(() => {
    if (prefixStats.length === 0) return null;
    // Sort by count desc; show top 10 prefixes to keep the chart short.
    const sorted = [...prefixStats].sort((a, b) => b.count - a.count).slice(0, 10);
    const names = sorted.map((p) => p.prefix);
    const okData = sorted.map((p) => p.successCount);
    const errData = sorted.map((p) => p.errorCount);
    return {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: {
        data: [t("OK"), t("Err")],
        bottom: 0,
        textStyle: { fontSize: 10 },
        itemWidth: 10,
        itemHeight: 10,
      },
      grid: { left: 8, right: 16, top: 16, bottom: 32, containLabel: true },
      xAxis: { type: "value", axisLabel: { fontSize: 10 } },
      yAxis: { type: "category", data: names, axisLabel: { fontSize: 10 } },
      series: [
        {
          name: t("OK"),
          type: "bar",
          stack: "total",
          data: okData,
          itemStyle: { color: COLOR_OK },
          emphasis: { focus: "series" },
        },
        {
          name: t("Err"),
          type: "bar",
          stack: "total",
          data: errData,
          itemStyle: { color: COLOR_ERR },
          emphasis: { focus: "series" },
        },
      ],
    };
  }, [prefixStats, t]);

  // Reverse so newest is at the top of the list
  const recentBash = useMemo(() => [...bashRecords].reverse(), [bashRecords]);
  const [showAllBash, setShowAllBash] = useState(false);
  const visibleBash = showAllBash ? recentBash : recentBash.slice(0, BASH_PREVIEW_LIMIT);
  const bashHiddenCount = Math.max(0, recentBash.length - BASH_PREVIEW_LIMIT);

  // ── Render ──

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--bg-panel)",
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

        {/* Empty state */}
        {totalCount === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center", padding: "20px 0" }}>
            {t("No tool calls yet")}
          </div>
        )}

        {/* ── Summary bar ── */}
        {totalCount > 0 && (
          <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
            <SummaryItem label={t("Total")} value={totalCount} color="var(--text)" />
            <SummaryItem
              label={t("Success")}
              value={totalSuccess}
              color={COLOR_OK}
            />
            <SummaryItem
              label={t("Errors")}
              value={totalErrors}
              color={totalErrors > 0 ? COLOR_ERR : "var(--text-dim)"}
            />
            {successRate !== null && (
              <SummaryItem
                label={t("Rate")}
                value={`${successRate}%`}
                color={successRate >= 90 ? COLOR_OK : successRate >= 50 ? "#f59e0b" : COLOR_ERR}
              />
            )}
            {runningCount > 0 && (
              <SummaryItem
                label={t("Running")}
                value={runningCount}
                color={COLOR_ACCENT}
              />
            )}
          </div>
        )}

        {/* ── Overview charts ── */}
        {toolEntries.length > 0 && (
          <Section title={t("Overview")}>
            <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
              {barOption && (
                <div style={{ flex: 1, minWidth: 0 }}>
                  <EchartsChart option={barOption} height={150} ariaLabel={t("By Tool")} />
                </div>
              )}
              {pieOption && (
                <div style={{ flex: "0 0 130px" }}>
                  <EchartsChart option={pieOption} height={150} ariaLabel={t("Overview")} />
                </div>
              )}
            </div>
          </Section>
        )}

        {/* ── Separator ── */}
        {bashRecords.length > 0 && toolEntries.length > 0 && (
          <div style={{ borderTop: "1px solid var(--border)" }} />
        )}

        {/* ── Bash analysis ── */}
        {bashRecords.length > 0 && (
          <Section title={t("Bash Analysis")}>
            {bashBarOption && (
              <EchartsChart option={bashBarOption} height={Math.min(180, 30 + prefixStats.slice(0, 10).length * 18)} ariaLabel={t("Command prefix")} />
            )}
            <BashCommandList
              records={visibleBash}
              hiddenCount={bashHiddenCount}
              showAll={showAllBash}
              onToggleShowAll={() => setShowAllBash((v) => !v)}
              onScrollToToolCall={onScrollToToolCall}
            />
          </Section>
        )}

        {/* Bash empty state — bash tool wasn't used this session */}
        {bashRecords.length === 0 && toolEntries.length > 0 && (
          <Section title={t("Bash Analysis")}>
            <div style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center", padding: "12px 0" }}>
              {t("No bash commands yet")}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-dim)",
          marginBottom: 6,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function SummaryItem({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
      <span style={{ fontWeight: 600, color, fontFamily: "var(--font-mono)" }}>{value}</span>
      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{label}</span>
    </div>
  );
}

function BashCommandList({
  records,
  hiddenCount,
  showAll,
  onToggleShowAll,
  onScrollToToolCall,
}: {
  records: BashRecord[];
  hiddenCount: number;
  showAll: boolean;
  onToggleShowAll: () => void;
  onScrollToToolCall?: (toolCallId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-dim)",
          marginBottom: 4,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>{t("Recent commands")}</span>
        {hiddenCount > 0 && (
          <button
            onClick={onToggleShowAll}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              padding: 0,
              textTransform: "none",
              letterSpacing: 0,
              fontWeight: 500,
            }}
          >
            {showAll ? t("Show less") : t("Show all ({n})").replace("{n}", String(records.length + hiddenCount))}
          </button>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {records.map((r) => (
          <BashCommandRow key={r.toolCallId} record={r} onClick={onScrollToToolCall} />
        ))}
      </div>
    </div>
  );
}

function BashCommandRow({ record, onClick }: { record: BashRecord; onClick?: (toolCallId: string) => void }) {
  const { t } = useI18n();
  const isError = record.isError || record.exit.kind === "nonzero" || record.exit.kind === "timeout" || record.exit.kind === "aborted";
  const statusColor = isError ? COLOR_ERR : COLOR_OK;
  const statusSymbol = isError ? "✗" : "✓";
  const exitLabel = formatExitLabel(record, t);
  const errorLine = isError && record.resultText ? firstErrorLine(record.resultText) : null;

  const row = (
    <div
      onClick={() => onClick?.(record.toolCallId)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "4px 6px",
        borderRadius: 3,
        cursor: onClick ? "pointer" : undefined,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
      }}
      onMouseEnter={(e) => { if (onClick) (e.currentTarget as HTMLElement).style.background = "var(--bg-subtle)"; }}
      onMouseLeave={(e) => { if (onClick) (e.currentTarget as HTMLElement).style.background = ""; }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ color: statusColor, flexShrink: 0, fontWeight: 600 }}>{statusSymbol}</span>
        <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {record.command || "(empty)"}
        </span>
        <span style={{ color: statusColor, flexShrink: 0, fontSize: 10 }}>{exitLabel}</span>
      </div>
      {errorLine && (
        <div
          style={{
            color: COLOR_ERR,
            fontSize: 10,
            opacity: 0.8,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            paddingLeft: 18,
          }}
        >
          {errorLine}
        </div>
      )}
    </div>
  );

  return (
    <Tooltip
      side="left"
      align="center"
      content={
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 320 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {record.command || "(empty)"}
          </div>
          <div style={{ fontSize: 10, color: statusColor }}>{exitLabel}</div>
          {errorLine && (
            <div style={{ fontSize: 10, color: "var(--text-dim)", borderTop: "1px solid var(--border)", paddingTop: 4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {errorLine}
            </div>
          )}
        </div>
      }
    >
      {row}
    </Tooltip>
  );
}

// ── Helpers ──

function formatExitLabel(record: BashRecord, t: (k: string) => string): string {
  const exit = record.exit;
  switch (exit.kind) {
    case "ok":
      return t("OK");
    case "nonzero":
      return t("Exit {code}").replace("{code}", String(exit.code));
    case "timeout":
      return t("timeout");
    case "aborted":
      return t("aborted");
    case "unknown":
      return record.isError ? t("failed") : "—";
  }
}

function firstErrorLine(text: string): string {
  // First non-empty line of the result text is usually the most actionable
  // (e.g. "ENOENT: no such file or directory", "npm ERR! ...", "fatal: ...").
  // Strip the trailing "[Showing last ... of ...] Full output: ..." truncation
  // footer added by pi so it doesn't dominate the preview.
  const cleaned = text.replace(/\n\n\[Showing last[^\]]+\]\s*$/g, "").trim();
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[0] ?? cleaned.slice(0, 120);
}

interface PrefixStat {
  prefix: string;
  count: number;
  successCount: number;
  errorCount: number;
}

function buildPrefixStats(records: BashRecord[]): PrefixStat[] {
  const map = new Map<string, PrefixStat>();
  for (const r of records) {
    const prefix = firstWord(r.command);
    if (!prefix) continue;
    const prev = map.get(prefix);
    const isErr = r.isError || r.exit.kind === "nonzero" || r.exit.kind === "timeout" || r.exit.kind === "aborted";
    if (prev) {
      prev.count += 1;
      if (isErr) prev.errorCount += 1;
      else prev.successCount += 1;
    } else {
      map.set(prefix, {
        prefix,
        count: 1,
        successCount: isErr ? 0 : 1,
        errorCount: isErr ? 1 : 0,
      });
    }
  }
  return Array.from(map.values());
}

function firstWord(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  // First whitespace-delimited token. Strip leading env-var assignments like
  // `FOO=bar cmd` so the prefix reflects the actual command, not env vars.
  const noEnv = trimmed.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  const m = noEnv.match(/^(\S+)/);
  return m ? m[1] : trimmed.slice(0, 32);
}
