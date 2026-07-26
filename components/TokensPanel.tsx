"use client";

/**
 * Token audit panel — a small dashboard for `~/.pi-web/token-audit.db`.
 *
 * Fetches four parallel JSON snapshots from `/api/token-audit/*` and lays them
 * out as a KPI strip + a 2-column ECharts grid + a compact recent-calls table.
 * The `EchartsChart` wrapper handles the dynamic import, dark-mode theme, and
 * dispose/re-init on option identity change, so each chart below is just a
 * `useMemo` of an `EChartsCoreOption`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type * as echarts from "echarts";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { EchartsChart } from "./EchartsChart";
import { useTheme } from "@/hooks/useTheme";
import type { SessionInfo } from "@/lib/types";
import type {
  Range,
  SummaryBucket,
  SummarizeResult,
  TokenCall,
} from "@/lib/token-audit-types";

interface TokensPanelProps {
  onSelectSession: (session: SessionInfo) => void;
}

const RANGES: Range[] = ["today", "7d", "30d", "all"];
const PAGE_LIMIT = 50;

// ── formatters ────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function fmtHour(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:00`;
}

function fmtMonthDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDayKey(key: string): number | null {
  // "YYYY-MM-DD" -> local midnight epoch-ms
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0).getTime();
}

// ── time-bucket zero-padding ──────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Fill gaps in a `SummaryBucket[]` keyed by YYYY-MM-DD between [from, to]. */
function zeroPadDaySeries(fromTs: number, toTs: number, raw: SummaryBucket[]): SummaryBucket[] {
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs < fromTs) return [];
  const byTs = new Map<number, SummaryBucket>();
  for (const b of raw) {
    const ts = fmtDayKey(b.key);
    if (ts !== null) byTs.set(ts, b);
  }
  const start = new Date(fromTs);
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const out: SummaryBucket[] = [];
  for (let t = startMs; t <= toTs; t += DAY_MS) {
    const hit = byTs.get(t);
    if (hit) {
      out.push(hit);
    } else {
      const d = new Date(t);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      out.push({
        key,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costTotal: 0,
        durationMs: 0,
        firstAt: 0,
        lastAt: 0,
      });
    }
  }
  return out;
}

// ── shared echarts palette + style ────────────────────────────────────────

// ECharts default categorical palette — high contrast in both light & dark themes.
const PALETTE = [
  "#5470c6",
  "#91cc75",
  "#fac858",
  "#ee6666",
  "#73c0de",
  "#3ba272",
  "#fc8452",
  "#9a60b4",
];

function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

// ECharts axis/tooltip labels adopt the surrounding theme via a tiny inline
// helper that reads CSS vars on the root. Memoized per theme so option identity
// is stable across re-renders that don't change preset/isDark.
function useChartTheme() {
  const { preset, isDark } = useTheme();
  return useMemo(() => {
    void preset;
    if (typeof document === "undefined") {
      return isDark
        ? { text: "#d4d4d4", axis: "#666", tooltipBg: "rgba(40,40,40,0.92)" }
        : { text: "#333", axis: "#bbb", tooltipBg: "rgba(255,255,255,0.95)" };
    }
    const cs = getComputedStyle(document.documentElement);
    const text = cs.getPropertyValue("--text").trim() || (isDark ? "#d4d4d4" : "#333");
    const axis = cs.getPropertyValue("--border").trim() || (isDark ? "#666" : "#ddd");
    const tooltipBg = isDark ? "rgba(40,40,40,0.92)" : "rgba(255,255,255,0.96)";
    return { text, axis, tooltipBg };
  }, [preset, isDark]);
}

// ── main component ────────────────────────────────────────────────────────

interface FetchState {
  time: SummarizeResult | null;
  model: SummarizeResult | null;
  session: SummarizeResult | null;
  calls: { rows: TokenCall[]; total: number } | null;
}

export function TokensPanel({ onSelectSession }: TokensPanelProps) {
  const { t } = useI18n();
  const toast = useToast();

  const [range, setRange] = useState<Range>("7d");
  const [state, setState] = useState<FetchState>({
    time: null,
    model: null,
    session: null,
    calls: null,
  });
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);

  const timeGroupBy: "hour" | "day" = range === "today" ? "hour" : "day";

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [timeRes, modelRes, sessionRes, callsRes] = await Promise.all([
        fetch(`/api/token-audit/summary?range=${range}&groupBy=${timeGroupBy}`),
        fetch(`/api/token-audit/summary?range=${range}&groupBy=model`),
        fetch(`/api/token-audit/summary?range=${range}&groupBy=session`),
        fetch(`/api/token-audit/calls?range=${range}&limit=${PAGE_LIMIT}&offset=${offset}`),
      ]);
      if (!timeRes.ok || !modelRes.ok || !sessionRes.ok || !callsRes.ok) {
        throw new Error(`HTTP ${timeRes.status}/${modelRes.status}/${sessionRes.status}/${callsRes.status}`);
      }
      const [time, model, session, calls] = (await Promise.all([
        timeRes.json(),
        modelRes.json(),
        sessionRes.json(),
        callsRes.json(),
      ])) as [SummarizeResult, SummarizeResult, SummarizeResult, { rows: TokenCall[]; total: number }];
      setState({ time, model, session, calls });
      if (offset > 0 && offset >= calls.total) setOffset(0);
    } catch (e) {
      toast.show({ kind: "error", message: `${t("Failed to load token audit")}: ${String(e)}` });
    } finally {
      setLoading(false);
    }
    // timeGroupBy is derived in render from range; range triggers the refetch.
  }, [range, timeGroupBy, offset, toast, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Reset paging on range change.
  useEffect(() => {
    setOffset(0);
  }, [range]);

  const totals = state.time?.totals;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)" }}>
      <Toolbar
        range={range}
        calls={state.calls}
        onChangeRange={setRange}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
        <KpiStrip totals={totals} totalCalls={state.calls?.total ?? 0} errorCount={countErrors(state.calls?.rows)} />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
            gap: 12,
          }}
        >
          <ChartCard title={t("Cost over time")}>
            <CostOverTimeChart range={range} buckets={state.time?.buckets ?? []} />
          </ChartCard>
          <ChartCard title={t("Token composition")}>
            <TokenCompositionChart range={range} buckets={state.time?.buckets ?? []} />
          </ChartCard>
          <ChartCard title={t("Cost by model")}>
            <CostByCategoryChart
              buckets={state.model?.buckets ?? []}
              totalCost={state.model?.totals.costTotal ?? 0}
              labelKey={(b) => b.key}
              unknownLabel={t("Unknown")}
            />
          </ChartCard>
          <ChartCard title={t("Cost by provider")}>
            <CostByCategoryChart
              buckets={groupByProvider(state.model?.buckets ?? [])}
              totalCost={state.model?.totals.costTotal ?? 0}
              labelKey={(b) => b.key}
              unknownLabel={t("Unknown")}
            />
          </ChartCard>
          <ChartCard title={t("Cache hit rate")}>
            <CacheHitRateChart range={range} buckets={state.time?.buckets ?? []} />
          </ChartCard>
          <ChartCard title={t("Top sessions by cost")}>
            <TopSessionsChart buckets={state.session?.buckets.slice(0, 10) ?? []} />
          </ChartCard>
        </div>

        <RecentCalls
          rows={state.calls?.rows ?? []}
          total={state.calls?.total ?? 0}
          offset={offset}
          loading={loading}
          onSelectSession={onSelectSession}
          onChangeOffset={setOffset}
        />
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

function countErrors(rows: TokenCall[] | undefined): number {
  if (!rows) return 0;
  let n = 0;
  for (const r of rows) if (r.error) n++;
  return n;
}

/** The model key is "provider/model_id". Aggregate by provider. */
function groupByProvider(buckets: SummaryBucket[]): SummaryBucket[] {
  const byProv = new Map<string, SummaryBucket>();
  for (const b of buckets) {
    const slash = b.key.indexOf("/");
    const prov = slash >= 0 ? b.key.slice(0, slash) : b.key;
    const prev = byProv.get(prov);
    if (prev) {
      prev.calls += b.calls;
      prev.inputTokens += b.inputTokens;
      prev.outputTokens += b.outputTokens;
      prev.cacheReadTokens += b.cacheReadTokens;
      prev.cacheWriteTokens += b.cacheWriteTokens;
      prev.costTotal += b.costTotal;
      prev.durationMs += b.durationMs;
      if (b.firstAt && (!prev.firstAt || b.firstAt < prev.firstAt)) prev.firstAt = b.firstAt;
      if (b.lastAt && b.lastAt > prev.lastAt) prev.lastAt = b.lastAt;
    } else {
      byProv.set(prov, { ...b, key: prov });
    }
  }
  const out = Array.from(byProv.values());
  out.sort((a, b) => b.costTotal - a.costTotal);
  return out;
}

// ── toolbar ───────────────────────────────────────────────────────────────

interface ToolbarProps {
  range: Range;
  calls: { rows: TokenCall[]; total: number } | null;
  onChangeRange: (r: Range) => void;
}

function Toolbar({ range, calls, onChangeRange }: ToolbarProps) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        flexWrap: "wrap",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginRight: 4 }}>
        {t("Token audit")}
      </span>
      {RANGES.map((r) => (
        <ChipButton key={r} active={range === r} onClick={() => onChangeRange(r)} label={rangeLabel(r, t)} />
      ))}
      <div style={{ flex: 1 }} />
      {calls && (
        <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {t("Showing {n} of {total}")
            .replace("{n}", String(calls.rows.length))
            .replace("{total}", String(calls.total))}
        </span>
      )}
    </div>
  );
}

function rangeLabel(r: Range, t: (k: string) => string): string {
  if (r === "today") return t("Today");
  if (r === "7d") return t("Last 7 days");
  if (r === "30d") return t("Last 30 days");
  return t("All time");
}

// ── KPI strip ─────────────────────────────────────────────────────────────

interface KpiStripProps {
  totals: SummaryBucket | undefined;
  totalCalls: number;
  errorCount: number;
}

function KpiStrip({ totals, totalCalls, errorCount }: KpiStripProps) {
  const { t } = useI18n();
  if (!totals) {
    return (
      <div style={kpiGridStyle}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <KpiCard key={i} label={i === 0 ? t("Total cost") : i === 1 ? t("Calls") : i === 2 ? t("Total tokens") : i === 3 ? t("Avg duration") : i === 4 ? t("Cache hit rate") : t("Errors")} value="—" />
        ))}
      </div>
    );
  }
  const totalTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const hitDenom = totals.inputTokens + totals.cacheReadTokens;
  const hitRate = hitDenom > 0 ? totals.cacheReadTokens / hitDenom : null;
  const avgMs = totals.calls > 0 ? totals.durationMs / totals.calls : 0;
  const errorRate = totalCalls > 0 ? errorCount / totalCalls : 0;
  return (
    <div style={kpiGridStyle}>
      <KpiCard label={t("Total cost")} value={fmtCost(totals.costTotal)} accent />
      <KpiCard label={t("Calls")} value={fmtNum(totalCalls || totals.calls)} sub={totals.calls > 0 ? `${totals.calls} ${t("audit")}` : undefined} />
      <KpiCard label={t("Total tokens")} value={fmtNum(totalTokens)} sub={t("incl. cache")} />
      <KpiCard label={t("Avg duration")} value={avgMs > 0 ? `${(avgMs / 1000).toFixed(1)}s` : "—"} />
      <KpiCard label={t("Cache hit rate")} value={hitRate === null ? "—" : fmtPct(hitRate)} sub={hitRate !== null ? fmtNum(totals.cacheReadTokens) : undefined} />
      <KpiCard
        label={t("Errors")}
        value={totalCalls > 0 ? `${errorCount} · ${fmtPct(errorRate)}` : "—"}
        warn={errorCount > 0}
      />
    </div>
  );
}

const kpiGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 8,
};

function KpiCard({
  label,
  value,
  sub,
  accent,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  warn?: boolean;
}) {
  const color = warn ? "#f87171" : accent ? "var(--accent)" : "var(--text)";
  return (
    <div
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        minHeight: 64,
      }}
    >
      <span style={{ fontSize: 16, fontWeight: 600, color, fontFamily: "var(--font-mono)", lineHeight: 1.2 }}>{value}</span>
      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{label}</span>
      {sub && <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{sub}</span>}
    </div>
  );
}

// ── chart card wrapper ────────────────────────────────────────────────────

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px 6px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: 0.2 }}>{title}</div>
      {children}
    </div>
  );
}

// ── charts ────────────────────────────────────────────────────────────────

/** Pad a series to align the chart x-axis to the range. */
function padTimeBuckets(range: Range, raw: SummaryBucket[]): { ts: number; b: SummaryBucket }[] {
  if (range === "today") {
    // Hour-of-day buckets are local time; the SQLite key is "YYYY-MM-DD HH:00".
    // We don't have a tsMs field here so parse from the key.
    const parsed = raw
      .map((b) => {
        const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(b.key);
        if (!m) return null;
        const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], 0, 0, 0).getTime();
        return { ts, b };
      })
      .filter((x): x is { ts: number; b: SummaryBucket } => x !== null);
    parsed.sort((a, b) => a.ts - b.ts);
    return parsed;
  }
  const parsed = raw
    .map((b) => {
      const ts = fmtDayKey(b.key);
      if (ts === null) return null;
      return { ts, b };
    })
    .filter((x): x is { ts: number; b: SummaryBucket } => x !== null);
  parsed.sort((a, b) => a.ts - b.ts);
  // Fill missing days in the visible window.
  const now = Date.now();
  let fromTs: number;
  if (range === "7d") fromTs = now - 7 * DAY_MS;
  else if (range === "30d") fromTs = now - 30 * DAY_MS;
  else {
    if (parsed.length === 0) return [];
    fromTs = parsed[0].ts;
  }
  return zeroPadDaySeries(fromTs, now, raw).map((b) => {
    const ts = fmtDayKey(b.key) ?? 0;
    return { ts, b };
  });
}

function CostOverTimeChart({ range, buckets }: { range: Range; buckets: SummaryBucket[] }) {
  const { t } = useI18n();
  const theme = useChartTheme();
  const series = useMemo(() => padTimeBuckets(range, buckets), [range, buckets]);
  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const xs = series.map((p) => (range === "today" ? fmtHour(p.ts) : fmtMonthDay(p.ts)));
    const costs = series.map((p) => +p.b.costTotal.toFixed(4));
    const calls = series.map((p) => p.b.calls);
    return {
      animation: false,
      grid: { left: 50, right: 50, top: 18, bottom: 22 },
      tooltip: { trigger: "axis", backgroundColor: theme.tooltipBg, borderColor: theme.axis, textStyle: { color: theme.text, fontSize: 11 } },
      xAxis: {
        type: "category",
        data: xs,
        axisLine: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.text, fontSize: 10, fontFamily: "var(--font-mono)", interval: range === "today" ? 2 : "auto" },
      },
      yAxis: [
        {
          type: "value",
          name: t("Cost"),
          nameTextStyle: { color: theme.text, fontSize: 10 },
          axisLabel: { color: theme.text, fontSize: 10, formatter: (v: number) => `$${v}` },
          splitLine: { lineStyle: { color: theme.axis, type: "dashed", opacity: 0.4 } },
        },
        {
          type: "value",
          name: t("Calls"),
          nameTextStyle: { color: theme.text, fontSize: 10 },
          axisLabel: { color: theme.text, fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: t("Cost"),
          type: "line",
          data: costs,
          smooth: true,
          symbol: "circle",
          symbolSize: 4,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.18 },
          color: PALETTE[0],
        },
        {
          name: t("Calls"),
          type: "bar",
          yAxisIndex: 1,
          data: calls,
          barWidth: "40%",
          itemStyle: { color: PALETTE[1], opacity: 0.55 },
        },
      ],
    };
  }, [series, theme, t, range]);
  return <EchartsChart option={option} height={220} ariaLabel={t("Cost over time")} />;
}

function TokenCompositionChart({ range, buckets }: { range: Range; buckets: SummaryBucket[] }) {
  const { t } = useI18n();
  const theme = useChartTheme();
  const series = useMemo(() => padTimeBuckets(range, buckets), [range, buckets]);
  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const xs = series.map((p) => (range === "today" ? fmtHour(p.ts) : fmtMonthDay(p.ts)));
    return {
      animation: false,
      grid: { left: 50, right: 14, top: 18, bottom: 22 },
      tooltip: { trigger: "axis", backgroundColor: theme.tooltipBg, borderColor: theme.axis, textStyle: { color: theme.text, fontSize: 11 } },
      legend: { textStyle: { color: theme.text, fontSize: 10 }, top: 0, right: 0, itemWidth: 10, itemHeight: 10 },
      xAxis: {
        type: "category",
        data: xs,
        axisLine: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.text, fontSize: 10, fontFamily: "var(--font-mono)", interval: range === "today" ? 2 : "auto" },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: theme.text, fontSize: 10, formatter: (v: number) => fmtNum(v) },
        splitLine: { lineStyle: { color: theme.axis, type: "dashed", opacity: 0.4 } },
      },
      series: [
        { name: t("Cache write"), type: "line", stack: "tokens", smooth: true, areaStyle: {}, symbol: "none", data: series.map((p) => p.b.cacheWriteTokens), color: PALETTE[7] },
        { name: t("Cache read"), type: "line", stack: "tokens", smooth: true, areaStyle: {}, symbol: "none", data: series.map((p) => p.b.cacheReadTokens), color: PALETTE[1] },
        { name: t("Input tokens"), type: "line", stack: "tokens", smooth: true, areaStyle: {}, symbol: "none", data: series.map((p) => p.b.inputTokens), color: PALETTE[0] },
        { name: t("Output tokens"), type: "line", stack: "tokens", smooth: true, areaStyle: {}, symbol: "none", data: series.map((p) => p.b.outputTokens), color: PALETTE[3] },
      ],
    };
  }, [series, theme, t, range]);
  return <EchartsChart option={option} height={220} ariaLabel={t("Token composition")} />;
}

function CostByCategoryChart({
  buckets,
  totalCost,
  labelKey,
  unknownLabel,
}: {
  buckets: SummaryBucket[];
  totalCost: number;
  labelKey: (b: SummaryBucket) => string;
  unknownLabel: string;
}) {
  const { t } = useI18n();
  const theme = useChartTheme();
  const option = useMemo<echarts.EChartsCoreOption>(() => {
    if (buckets.length === 0) {
      return emptyDonut(theme, totalCost);
    }
    const top = buckets.slice(0, 6);
    const rest = buckets.slice(6);
    const restCost = rest.reduce((s, b) => s + b.costTotal, 0);
    const data = top.map((b, i) => ({
      name: shortLabel(labelKey(b)),
      value: +b.costTotal.toFixed(4),
      itemStyle: { color: paletteColor(i) },
    }));
    if (rest.length > 0) {
      data.push({ name: unknownLabel, value: +restCost.toFixed(4), itemStyle: { color: "#888" } });
    }
    return {
      animation: false,
      tooltip: { trigger: "item", backgroundColor: theme.tooltipBg, borderColor: theme.axis, textStyle: { color: theme.text, fontSize: 11 }, formatter: ((p: unknown): string => {
          const pp = p as { marker?: string; name?: string; value?: number; percent?: number };
          return `${pp.marker ?? ""} ${pp.name ?? ""}<br/>${fmtCost(pp.value ?? 0)} (${pp.percent ?? 0}%)`;
        }) as never },
      legend: {
        type: "scroll",
        orient: "vertical",
        right: 4,
        top: "middle",
        textStyle: { color: theme.text, fontSize: 10 },
        itemWidth: 10,
        itemHeight: 10,
        formatter: (name: string) => truncate(name, 22),
      },
      series: [
        {
          type: "pie",
          radius: ["52%", "78%"],
          center: ["38%", "50%"],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: theme.tooltipBg, borderWidth: 2 },
          label: { show: false },
          labelLine: { show: false },
          data,
        },
      ],
      graphic: [
        {
          type: "text",
          left: "38%",
          top: "46%",
          style: { text: fmtCost(totalCost), fill: theme.text, fontSize: 14, fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "center" },
        },
        {
          type: "text",
          left: "38%",
          top: "60%",
          style: { text: t("Total cost"), fill: theme.text, fontSize: 10, textAlign: "center" },
        },
      ],
    };
  }, [buckets, totalCost, theme, labelKey, t, unknownLabel]);
  return <EchartsChart option={option} height={260} ariaLabel={t("Cost by category")} />;
}

function CacheHitRateChart({ range, buckets }: { range: Range; buckets: SummaryBucket[] }) {
  const { t } = useI18n();
  const theme = useChartTheme();
  const series = useMemo(() => padTimeBuckets(range, buckets), [range, buckets]);
  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const xs = series.map((p) => (range === "today" ? fmtHour(p.ts) : fmtMonthDay(p.ts)));
    const rates = series.map((p) => {
      const denom = p.b.inputTokens + p.b.cacheReadTokens;
      if (denom === 0) return null;
      return +(p.b.cacheReadTokens / denom * 100).toFixed(1);
    });
    return {
      animation: false,
      grid: { left: 50, right: 14, top: 18, bottom: 22 },
      tooltip: { trigger: "axis", backgroundColor: theme.tooltipBg, borderColor: theme.axis, textStyle: { color: theme.text, fontSize: 11 }, valueFormatter: ((v: unknown) => (v == null ? "—" : `${v}%`)) as never },
      xAxis: {
        type: "category",
        data: xs,
        axisLine: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.text, fontSize: 10, fontFamily: "var(--font-mono)", interval: range === "today" ? 2 : "auto" },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 100,
        axisLabel: { color: theme.text, fontSize: 10, formatter: (v: number) => `${v}%` },
        splitLine: { lineStyle: { color: theme.axis, type: "dashed", opacity: 0.4 } },
      },
      series: [
        {
          type: "line",
          data: rates,
          smooth: true,
          symbol: "circle",
          symbolSize: 4,
          connectNulls: true,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.18 },
          color: PALETTE[2],
        },
      ],
    };
  }, [series, theme, range]);
  return <EchartsChart option={option} height={220} ariaLabel={t("Cache hit rate")} />;
}

function TopSessionsChart({ buckets }: { buckets: SummaryBucket[] }) {
  const { t } = useI18n();
  const theme = useChartTheme();
  const option = useMemo<echarts.EChartsCoreOption>(() => {
    if (buckets.length === 0) return emptyBars(theme, t("No token usage recorded yet."));
    const sorted = [...buckets].sort((a, b) => b.costTotal - a.costTotal);
    return {
      animation: false,
      grid: { left: 12, right: 60, top: 8, bottom: 8, containLabel: true },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: theme.tooltipBg, borderColor: theme.axis, textStyle: { color: theme.text, fontSize: 11 }, formatter: ((params: unknown): string => {
        const arr = Array.isArray(params) ? params : [params];
        const p = arr[0] as { name?: string; value?: number };
        return `<div style="font-family:var(--font-mono);font-size:11px">${shortLabel(p.name ?? "")}<br/>${fmtCost(p.value ?? 0)}</div>`;
      }) as never },
      xAxis: {
        type: "value",
        axisLabel: { color: theme.text, fontSize: 10, formatter: (v: number) => `$${v}` },
        splitLine: { lineStyle: { color: theme.axis, type: "dashed", opacity: 0.4 } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((b) => shortLabel(b.key, 18)).reverse(),
        axisLine: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.text, fontSize: 10, fontFamily: "var(--font-mono)" },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((b, i) => ({ value: +b.costTotal.toFixed(4), itemStyle: { color: paletteColor(i) } })).reverse(),
          barWidth: "60%",
        },
      ],
    };
  }, [buckets, theme, t]);
  return <EchartsChart option={option} height={260} ariaLabel={t("Top sessions by cost")} />;
}

// ── recent calls table ────────────────────────────────────────────────────

interface RecentCallsProps {
  rows: TokenCall[];
  total: number;
  offset: number;
  loading: boolean;
  onSelectSession: (s: SessionInfo) => void;
  onChangeOffset: (n: number) => void;
}

function RecentCalls({ rows, total, offset, loading, onSelectSession, onChangeOffset }: RecentCallsProps) {
  const { t } = useI18n();
  return (
    <div
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span>{t("Recent calls")}</span>
        {loading && <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 400 }}>{t("Loading...")}</span>}
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: "20px 12px", textAlign: "center", fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>
          {t("No token usage recorded yet.")}
        </div>
      ) : (
        <div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "70px 1fr 60px 100px 70px 24px",
              gap: 8,
              padding: "6px 12px",
              fontSize: 10,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg)",
            }}
          >
            <span>{t("Time")}</span>
            <span>{t("Model")}</span>
            <span style={{ textAlign: "right" }}>{t("Tokens")}</span>
            <span style={{ textAlign: "right" }}>{t("Cost")}</span>
            <span style={{ textAlign: "right" }}>{t("Duration")}</span>
            <span />
          </div>
          {rows.map((r) => (
            <CallRow key={r.id} row={r} onSelectSession={onSelectSession} />
          ))}
        </div>
      )}
      {total > PAGE_LIMIT && (
        <Pagination offset={offset} total={total} onChange={onChangeOffset} />
      )}
    </div>
  );
}

function CallRow({ row, onSelectSession }: { row: TokenCall; onSelectSession: (s: SessionInfo) => void }) {
  const handleClick = useCallback(() => {
    onSelectSession({
      id: row.sessionId,
      path: "",
      cwd: "",
      created: "",
      modified: "",
      messageCount: 0,
    } as SessionInfo);
  }, [onSelectSession, row.sessionId]);
  const tokenIn = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
  const isError = !!row.error;
  return (
    <div
      onClick={handleClick}
      style={{
        display: "grid",
        gridTemplateColumns: "70px 1fr 60px 100px 70px 24px",
        gap: 8,
        padding: "6px 12px",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        color: "var(--text)",
        borderBottom: "1px solid var(--border)",
        background: isError ? "rgba(239, 68, 68, 0.06)" : "transparent",
        cursor: "pointer",
        transition: "background 0.1s",
        alignItems: "center",
      }}
      onMouseEnter={(e) => {
        if (!isError) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = isError ? "rgba(239, 68, 68, 0.06)" : "transparent";
      }}
    >
      <span style={{ color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{fmtTime(row.ts)}</span>
      <span title={`${row.provider}/${row.modelId}`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {row.provider}/{row.modelId}
      </span>
      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtNum(tokenIn + row.outputTokens)}</span>
      <span style={{ textAlign: "right", color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>{fmtCost(row.costTotal)}</span>
      <span style={{ textAlign: "right", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{(row.durationMs / 1000).toFixed(1)}s</span>
      <span style={{ textAlign: "center", color: isError ? "#f87171" : "var(--text-dim)", fontSize: 12 }}>
        {isError ? <Tooltip content={row.error ?? "error"}><span>!</span></Tooltip> : ""}
      </span>
    </div>
  );
}

function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (n: number) => void }) {
  const { t } = useI18n();
  const page = Math.floor(offset / PAGE_LIMIT) + 1;
  const pages = Math.ceil(total / PAGE_LIMIT);
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "6px 12px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
        fontSize: 11,
      }}
    >
      <button onClick={() => onChange(Math.max(0, offset - PAGE_LIMIT))} disabled={offset === 0} style={pageBtnStyle(offset === 0)}>
        {t("Previous page")}
      </button>
      <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {page} / {pages}
      </span>
      <button onClick={() => onChange(offset + PAGE_LIMIT < total ? offset + PAGE_LIMIT : offset)} disabled={offset + PAGE_LIMIT >= total} style={pageBtnStyle(offset + PAGE_LIMIT >= total)}>
        {t("Next page")}
      </button>
    </div>
  );
}

// ── atoms ─────────────────────────────────────────────────────────────────

function pageBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "2px 10px",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 4,
    color: disabled ? "var(--text-dim)" : "var(--text)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 11,
  };
}

function ChipButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 4,
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "var(--bg-selected)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-muted)",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        transition: "all 0.1s",
      }}
    >
      {label}
    </button>
  );
}

// ── shared helpers ────────────────────────────────────────────────────────

function shortLabel(s: string, max = 32): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function emptyDonut(theme: ReturnType<typeof useChartTheme>, totalCost: number): echarts.EChartsCoreOption {
  return {
    animation: false,
    series: [
      {
        type: "pie",
        radius: ["52%", "78%"],
        center: ["38%", "50%"],
        itemStyle: { color: theme.axis },
        label: { show: false },
        data: [{ name: "—", value: 1 }],
      },
    ],
    graphic: [
      { type: "text", left: "38%", top: "46%", style: { text: fmtCost(totalCost), fill: theme.text, fontSize: 14, fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "center" } },
      { type: "text", left: "38%", top: "60%", style: { text: "—", fill: theme.text, fontSize: 10, textAlign: "center" } },
    ],
  };
}

function emptyBars(theme: ReturnType<typeof useChartTheme>, message: string): echarts.EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 12, right: 60, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: "value", show: false },
    yAxis: { type: "category", data: [], axisLabel: { color: theme.text } },
    series: [{ type: "bar", data: [] }],
    graphic: [{ type: "text", left: "center", top: "middle", style: { text: message, fill: theme.text, fontSize: 11, fontStyle: "italic", textAlign: "center" } }],
  };
}